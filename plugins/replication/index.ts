import { StarbaseApp, StarbaseDBConfiguration } from '../../src/handler'
import { StarbasePlugin } from '../../src/plugin'
import { executeQuery } from '../../src/operation'
import { DataSource, QueryResult } from '../../src/types'
import { createResponse } from '../../src/utils'
import { CronPlugin } from '../cron'

/**
 * Configuration describing a single external -> internal table replication.
 */
export interface ReplicationTableConfig {
    // Name of the table on the external data source to pull rows from.
    sourceTable: string
    // Name of the table in the internal DO SQLite to write rows into.
    // Defaults to `sourceTable` when omitted.
    targetTable?: string
    // Column used to track incremental progress (e.g. `id` or `created_at`).
    // Rows are pulled in ascending order of this column and only rows greater
    // than the last replicated value are fetched, enabling append-only polling.
    cursorColumn: string
    // Column used as the primary key for upserts into the internal table.
    // Defaults to `cursorColumn` when omitted.
    primaryKeyColumn?: string
    // Maximum number of rows to pull per run for this table.
    batchSize?: number
}

export interface ReplicationPluginConfig {
    // Tables to replicate from the external source into the internal source.
    tables: ReplicationTableConfig[]
    // Optional cron expression. When provided (and a CronPlugin instance is
    // passed) replication runs automatically on the given interval.
    schedule?: string
    // Default batch size applied to tables that do not specify their own.
    defaultBatchSize?: number
}

const DEFAULT_BATCH_SIZE = 1000

const SQL_QUERIES = {
    CREATE_CHECKPOINT_TABLE: `
        CREATE TABLE IF NOT EXISTS tmp_replication_checkpoints (
            target_table TEXT NOT NULL PRIMARY KEY,
            cursor_column TEXT NOT NULL,
            last_value TEXT,
            rows_replicated INTEGER NOT NULL DEFAULT 0,
            last_run_at TEXT,
            last_error TEXT
        )
    `,
    GET_CHECKPOINT: `
        SELECT last_value FROM tmp_replication_checkpoints WHERE target_table = ?
    `,
    GET_ALL_CHECKPOINTS: `
        SELECT target_table, cursor_column, last_value, rows_replicated, last_run_at, last_error
        FROM tmp_replication_checkpoints
    `,
    UPSERT_CHECKPOINT: `
        INSERT INTO tmp_replication_checkpoints
            (target_table, cursor_column, last_value, rows_replicated, last_run_at, last_error)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(target_table) DO UPDATE SET
            cursor_column = excluded.cursor_column,
            last_value = excluded.last_value,
            rows_replicated = tmp_replication_checkpoints.rows_replicated + excluded.rows_replicated,
            last_run_at = excluded.last_run_at,
            last_error = excluded.last_error
    `,
}

export interface ReplicationRunResult {
    table: string
    rowsReplicated: number
    lastValue: string | null
    error?: string
}

/**
 * ReplicationPlugin pulls rows from an external data source (e.g. a Postgres
 * instance on Supabase) into the internal Durable Object SQLite database so the
 * StarbaseDB instance can serve as a close-to-edge replica.
 *
 * The pull is incremental and append-only: for each configured table a cursor
 * column is tracked and only rows with a cursor value greater than the last
 * replicated value are fetched on subsequent runs. Progress is persisted in the
 * internal `tmp_replication_checkpoints` table so it survives DO hibernation.
 *
 * Replication can be triggered manually via the admin HTTP endpoints or, when a
 * CronPlugin instance and a `schedule` are provided, automatically on an
 * interval.
 */
export class ReplicationPlugin extends StarbasePlugin {
    public pathPrefix: string = '/replication'
    private dataSource?: DataSource
    private config?: StarbaseDBConfiguration
    private replicationConfig: ReplicationPluginConfig
    private cron?: CronPlugin
    private initialized = false

    constructor(opts: { config: ReplicationPluginConfig; cron?: CronPlugin }) {
        super('starbasedb:replication', {
            requiresAuth: true,
        })
        this.replicationConfig = opts.config
        this.cron = opts.cron
    }

    override async register(app: StarbaseApp) {
        app.use(async (c, next) => {
            this.dataSource = c?.get('dataSource')
            this.config = c?.get('config')
            await this.init()
            await next()
        })

        // Trigger a replication run for all configured tables (or a single
        // table when `?table=` is provided).
        app.post(`${this.pathPrefix}/run`, async (c) => {
            if (this.config?.role !== 'admin') {
                return createResponse(undefined, 'Unauthorized request', 401)
            }

            const onlyTable = c.req.query('table')
            const results = await this.replicate(onlyTable)
            return createResponse({ results }, undefined, 200)
        })

        // Return the current replication checkpoints / status.
        app.get(`${this.pathPrefix}/status`, async (c) => {
            if (this.config?.role !== 'admin') {
                return createResponse(undefined, 'Unauthorized request', 401)
            }

            if (!this.dataSource) {
                return createResponse(undefined, 'Data source not found', 500)
            }

            const checkpoints = (await this.dataSource.rpc.executeQuery({
                sql: SQL_QUERIES.GET_ALL_CHECKPOINTS,
                params: [],
            })) as QueryResult[]

            return createResponse({ checkpoints }, undefined, 200)
        })
    }

    private async init() {
        if (this.initialized || !this.dataSource) return

        await this.dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.CREATE_CHECKPOINT_TABLE,
            params: [],
        })

        // Register an automatic replication run with the CronPlugin when a
        // schedule is configured. The cron callback hits our own run logic.
        if (this.cron && this.replicationConfig.schedule) {
            this.cron.onEvent(async ({ name }) => {
                if (name === this.name) {
                    await this.replicate()
                }
            }, this.dataSource.executionContext)
        }

        this.initialized = true
    }

    /**
     * Run replication for all configured tables, or just `onlyTable` when set.
     * Each table is replicated independently: a failure on one table does not
     * abort replication of the others (fail-open).
     */
    public async replicate(
        onlyTable?: string
    ): Promise<ReplicationRunResult[]> {
        if (!this.dataSource) {
            throw new Error('ReplicationPlugin not properly initialized')
        }

        if (!this.dataSource.external) {
            throw new Error(
                'No external data source configured to replicate from'
            )
        }

        const tables = onlyTable
            ? this.replicationConfig.tables.filter(
                  (t) => (t.targetTable ?? t.sourceTable) === onlyTable
              )
            : this.replicationConfig.tables

        const results: ReplicationRunResult[] = []

        for (const table of tables) {
            try {
                results.push(await this.replicateTable(table))
            } catch (error) {
                const message =
                    error instanceof Error ? error.message : String(error)
                console.error(
                    `Replication failed for table ${table.sourceTable}:`,
                    error
                )
                await this.saveCheckpoint(
                    table.targetTable ?? table.sourceTable,
                    table.cursorColumn,
                    null,
                    0,
                    message
                )
                results.push({
                    table: table.targetTable ?? table.sourceTable,
                    rowsReplicated: 0,
                    lastValue: null,
                    error: message,
                })
            }
        }

        return results
    }

    private async replicateTable(
        table: ReplicationTableConfig
    ): Promise<ReplicationRunResult> {
        const targetTable = table.targetTable ?? table.sourceTable
        const primaryKey = table.primaryKeyColumn ?? table.cursorColumn
        const batchSize =
            table.batchSize ??
            this.replicationConfig.defaultBatchSize ??
            DEFAULT_BATCH_SIZE

        const lastValue = await this.getCheckpoint(targetTable)

        // Pull a bounded, ordered batch of rows from the external source that
        // are newer than the last replicated cursor value (append-only polling).
        const rows = await this.fetchExternalRows(
            table.sourceTable,
            table.cursorColumn,
            lastValue,
            batchSize
        )

        if (rows.length === 0) {
            await this.saveCheckpoint(
                targetTable,
                table.cursorColumn,
                lastValue,
                0,
                null
            )
            return { table: targetTable, rowsReplicated: 0, lastValue }
        }

        const columns = Object.keys(rows[0])
        await this.ensureTargetTable(targetTable, columns, primaryKey)

        let newCursorValue = lastValue
        for (const row of rows) {
            await this.upsertRow(targetTable, columns, primaryKey, row)
            const cursorValue = row[table.cursorColumn]
            if (cursorValue !== undefined && cursorValue !== null) {
                newCursorValue = String(cursorValue)
            }
        }

        await this.saveCheckpoint(
            targetTable,
            table.cursorColumn,
            newCursorValue,
            rows.length,
            null
        )

        return {
            table: targetTable,
            rowsReplicated: rows.length,
            lastValue: newCursorValue,
        }
    }

    /**
     * Read a batch of rows from the external data source using the existing
     * `executeQuery` operation pointed at the external connection.
     */
    private async fetchExternalRows(
        sourceTable: string,
        cursorColumn: string,
        lastValue: string | null,
        batchSize: number
    ): Promise<Record<string, unknown>[]> {
        const externalDataSource: DataSource = {
            ...this.dataSource!,
            source: 'external',
        }

        const where =
            lastValue !== null
                ? `WHERE ${quoteIdentifier(cursorColumn)} > ?`
                : ''
        const params = lastValue !== null ? [lastValue] : []

        const sql =
            `SELECT * FROM ${quoteIdentifier(sourceTable)} ${where} ` +
            `ORDER BY ${quoteIdentifier(cursorColumn)} ASC LIMIT ${Number(batchSize)}`

        const result = await executeQuery({
            sql,
            params,
            isRaw: false,
            dataSource: externalDataSource,
            config: this.config!,
        })

        return (result as Record<string, unknown>[]) ?? []
    }

    private async ensureTargetTable(
        targetTable: string,
        columns: string[],
        primaryKey: string
    ) {
        const columnDefs = columns
            .map((col) => {
                const def = quoteIdentifier(col)
                return col === primaryKey ? `${def} PRIMARY KEY` : def
            })
            .join(', ')

        await this.dataSource!.rpc.executeQuery({
            sql: `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(targetTable)} (${columnDefs})`,
            params: [],
        })
    }

    private async upsertRow(
        targetTable: string,
        columns: string[],
        primaryKey: string,
        row: Record<string, unknown>
    ) {
        const placeholders = columns.map(() => '?').join(', ')
        const columnList = columns.map(quoteIdentifier).join(', ')
        const updates = columns
            .filter((col) => col !== primaryKey)
            .map(
                (col) =>
                    `${quoteIdentifier(col)} = excluded.${quoteIdentifier(col)}`
            )
            .join(', ')

        // Upsert keyed on the primary key so re-running replication is
        // idempotent and never produces duplicate rows.
        const conflictClause = updates
            ? `ON CONFLICT(${quoteIdentifier(primaryKey)}) DO UPDATE SET ${updates}`
            : `ON CONFLICT(${quoteIdentifier(primaryKey)}) DO NOTHING`

        const sql =
            `INSERT INTO ${quoteIdentifier(targetTable)} (${columnList}) ` +
            `VALUES (${placeholders}) ${conflictClause}`

        await this.dataSource!.rpc.executeQuery({
            sql,
            params: columns.map((col) => normalizeValue(row[col])),
        })
    }

    private async getCheckpoint(targetTable: string): Promise<string | null> {
        const result = (await this.dataSource!.rpc.executeQuery({
            sql: SQL_QUERIES.GET_CHECKPOINT,
            params: [targetTable],
        })) as QueryResult[]

        if (result.length === 0) return null
        const lastValue = result[0].last_value
        return lastValue !== undefined && lastValue !== null
            ? String(lastValue)
            : null
    }

    private async saveCheckpoint(
        targetTable: string,
        cursorColumn: string,
        lastValue: string | null,
        rowsReplicated: number,
        error: string | null
    ) {
        await this.dataSource!.rpc.executeQuery({
            sql: SQL_QUERIES.UPSERT_CHECKPOINT,
            params: [
                targetTable,
                cursorColumn,
                lastValue,
                rowsReplicated,
                new Date().toISOString(),
                error,
            ],
        })
    }
}

/**
 * Quote a SQL identifier (table/column name) to guard against injection via
 * configured table/column names. Embedded double quotes are escaped.
 */
function quoteIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`
}

/**
 * Normalize a value coming from the external source into something the internal
 * SQLite store can bind. Objects/arrays are JSON-encoded; everything else is
 * passed through.
 */
function normalizeValue(value: unknown): unknown {
    if (value === undefined) return null
    if (
        value !== null &&
        typeof value === 'object' &&
        !(value instanceof Date)
    ) {
        return JSON.stringify(value)
    }
    if (value instanceof Date) {
        return value.toISOString()
    }
    return value
}
