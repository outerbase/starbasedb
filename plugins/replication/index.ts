import { StarbaseApp, StarbaseDBConfiguration } from '../../src/handler'
import { StarbasePlugin } from '../../src/plugin'
import { DataSource, QueryResult } from '../../src/types'
import { createResponse } from '../../src/utils'
import { executeExternalQuery } from '../../src/operation'

/**
 * Configuration for a single table that should be replicated from the
 * external data source into the internal Durable Object SQLite database.
 */
export interface ReplicationTableConfig {
    // Name of the table on the external data source (and locally).
    table: string
    // Schema of the table on the external data source (e.g. `public` for Postgres).
    schema?: string
    // Optional column used for append-only polling (e.g. `id` or `created_at`).
    // When provided, only rows with a greater value than the last synced
    // watermark are pulled on each cycle.
    watermarkColumn?: string
    // Maximum number of rows pulled per sync cycle. Defaults to 500.
    batchSize?: number
}

export interface ReplicationPluginOptions {
    // Tables that should be replicated from the external source.
    tables: ReplicationTableConfig[]
    // Interval (in milliseconds) between automatic sync cycles. When omitted,
    // syncs only run when triggered manually via the `/replication/sync` route
    // or by calling `syncNow()`.
    intervalMs?: number
    // Injectable external query executor, primarily for testing. Defaults to
    // running the query against the configured external data source.
    queryExternal?: (opts: {
        sql: string
        params?: unknown[]
        dataSource: DataSource
        config: StarbaseDBConfiguration
    }) => Promise<QueryResult[]>
}

interface ReplicationStateRow {
    table_name: string
    schema_name: string | null
    watermark_column: string | null
    last_value: string | null
    last_sync_at: number | null
}

export interface ReplicationSyncResult {
    table: string
    rowsReplicated: number
    lastValue: string | null
}

const DEFAULT_BATCH_SIZE = 500

const SQL_QUERIES = {
    CREATE_STATE_TABLE: `
        CREATE TABLE IF NOT EXISTS tmp_replication_state (
            table_name TEXT PRIMARY KEY,
            schema_name TEXT,
            watermark_column TEXT,
            last_value TEXT,
            last_sync_at INTEGER
        )
    `,
    GET_STATE: `
        SELECT table_name, schema_name, watermark_column, last_value, last_sync_at
        FROM tmp_replication_state
        WHERE table_name = ?
    `,
    UPSERT_STATE: `
        INSERT OR REPLACE INTO tmp_replication_state
            (table_name, schema_name, watermark_column, last_value, last_sync_at)
        VALUES (?, ?, ?, ?, ?)
    `,
    GET_ALL_STATE: `
        SELECT table_name, schema_name, watermark_column, last_value, last_sync_at
        FROM tmp_replication_state
    `,
}

// Identifiers are interpolated into SQL statements, so restrict them to a
// safe subset of characters to prevent SQL injection.
const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

function assertIdentifier(value: string, kind: string): string {
    if (!IDENTIFIER_PATTERN.test(value)) {
        throw new Error(`Invalid ${kind} identifier: ${value}`)
    }
    return value
}

function quoteIdentifier(value: string): string {
    return `"${assertIdentifier(value, 'table/column').replace(/"/g, '""')}"`
}

export class ReplicationPlugin extends StarbasePlugin {
    public pathPrefix: string = '/replication'
    private tables: ReplicationTableConfig[]
    private intervalMs?: number
    private queryExternal: NonNullable<ReplicationPluginOptions['queryExternal']>
    private dataSource?: DataSource
    private config?: StarbaseDBConfiguration
    private syncing: boolean = false

    constructor(opts: ReplicationPluginOptions) {
        super('starbasedb:replication', {
            requiresAuth: true,
        })
        this.tables = opts.tables
        this.intervalMs = opts.intervalMs
        this.queryExternal =
            opts.queryExternal ??
            (async ({ sql, params, dataSource, config }) =>
                (await executeExternalQuery({
                    sql,
                    params,
                    dataSource,
                    config,
                })) as QueryResult[])
    }

    override async register(app: StarbaseApp) {
        app.use(async (c, next) => {
            this.dataSource = c?.get('dataSource')
            this.config = c?.get('config')
            await this.init()
            await this.maybeAutoSync()
            await next()
        })

        // Manually trigger a replication sync cycle (admin only).
        app.post(`${this.pathPrefix}/sync`, async (c) => {
            if (this.config?.role !== 'admin') {
                return createResponse(undefined, 'Unauthorized request', 401)
            }

            const results = await this.syncNow()
            return createResponse({ results }, undefined, 200)
        })

        // Inspect the replication state of each configured table (admin only).
        app.get(`${this.pathPrefix}/status`, async (c) => {
            if (this.config?.role !== 'admin') {
                return createResponse(undefined, 'Unauthorized request', 401)
            }

            const state = await this.getStatus()
            return createResponse({ state }, undefined, 200)
        })
    }

    private async init() {
        if (!this.dataSource) return

        await this.dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.CREATE_STATE_TABLE,
            params: [],
        })
    }

    /**
     * On each request, check whether the configured interval has elapsed since
     * the last sync and, if so, kick off a background sync cycle.
     */
    private async maybeAutoSync() {
        if (!this.dataSource || !this.intervalMs || this.tables.length === 0)
            return
        if (this.syncing) return

        try {
            const state = (await this.dataSource.rpc.executeQuery({
                sql: SQL_QUERIES.GET_ALL_STATE,
                params: [],
            })) as ReplicationStateRow[]

            const now = Date.now()
            const due = this.tables.some((t) => {
                const row = state.find((s) => s.table_name === t.table)
                return !row?.last_sync_at || now - row.last_sync_at >= this.intervalMs!
            })

            if (due) {
                const promise = this.syncNow()
                if (this.dataSource.executionContext) {
                    this.dataSource.executionContext.waitUntil(promise)
                }
            }
        } catch (error) {
            console.error('Error checking replication schedule:', error)
        }
    }

    /**
     * Run a single replication cycle across all configured tables.
     */
    public async syncNow(): Promise<ReplicationSyncResult[]> {
        if (!this.dataSource) {
            throw new Error('ReplicationPlugin not properly initialized')
        }
        if (this.syncing) {
            return []
        }

        this.syncing = true
        try {
            const results: ReplicationSyncResult[] = []
            for (const table of this.tables) {
                try {
                    results.push(await this.syncTable(table))
                } catch (error) {
                    console.error(
                        `Error replicating table ${table.table}:`,
                        error
                    )
                }
            }
            return results
        } finally {
            this.syncing = false
        }
    }

    private async syncTable(
        table: ReplicationTableConfig
    ): Promise<ReplicationSyncResult> {
        const dataSource = this.dataSource!
        const config = this.config!
        const batchSize = table.batchSize ?? DEFAULT_BATCH_SIZE

        const tableName = assertIdentifier(table.table, 'table')
        const schemaName = table.schema
            ? assertIdentifier(table.schema, 'schema')
            : undefined
        const watermarkColumn = table.watermarkColumn
            ? assertIdentifier(table.watermarkColumn, 'watermark column')
            : undefined

        const qualifiedName = schemaName
            ? `${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)}`
            : quoteIdentifier(tableName)

        // Load the last known watermark for this table.
        const stateRows = (await dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.GET_STATE,
            params: [tableName],
        })) as ReplicationStateRow[]
        const state = stateRows[0]
        const lastValue = state?.last_value ?? null

        // Pull the next batch of rows from the external source.
        let externalSql = `SELECT * FROM ${qualifiedName}`
        const params: unknown[] = []
        if (watermarkColumn && lastValue !== null) {
            externalSql += ` WHERE ${quoteIdentifier(watermarkColumn)} > ?`
            params.push(lastValue)
        }
        if (watermarkColumn) {
            externalSql += ` ORDER BY ${quoteIdentifier(watermarkColumn)} ASC`
        }
        externalSql += ` LIMIT ?`
        params.push(batchSize)

        const rows = await this.queryExternal({
            sql: externalSql,
            params,
            dataSource,
            config,
        })

        let newLastValue = lastValue
        if (rows.length > 0) {
            await this.ensureLocalTable(tableName, rows[0])
            await this.insertRows(tableName, rows)

            if (watermarkColumn) {
                for (const row of rows) {
                    const value = row[watermarkColumn]
                    if (value !== null && value !== undefined) {
                        newLastValue = this.maxWatermark(newLastValue, value)
                    }
                }
            }
        }

        await dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.UPSERT_STATE,
            params: [
                tableName,
                schemaName ?? null,
                watermarkColumn ?? null,
                newLastValue !== null ? String(newLastValue) : null,
                Date.now(),
            ],
        })

        return {
            table: tableName,
            rowsReplicated: rows.length,
            lastValue: newLastValue !== null ? String(newLastValue) : null,
        }
    }

    /**
     * Create the local replica table if it does not exist yet. Columns are
     * declared without a type so SQLite preserves the original value types
     * (important for numeric watermark comparisons).
     */
    private async ensureLocalTable(
        tableName: string,
        sampleRow: QueryResult
    ) {
        const columns = Object.keys(sampleRow)
        if (columns.length === 0) return

        const columnDefs = columns.map((c) => quoteIdentifier(c)).join(', ')
        await this.dataSource!.rpc.executeQuery({
            sql: `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(tableName)} (${columnDefs})`,
            params: [],
        })
    }

    private async insertRows(tableName: string, rows: QueryResult[]) {
        const columns = Object.keys(rows[0])
        const placeholders = columns.map(() => '?').join(', ')
        const sql = `INSERT OR REPLACE INTO ${quoteIdentifier(tableName)} (${columns
            .map((c) => quoteIdentifier(c))
            .join(', ')}) VALUES (${placeholders})`

        for (const row of rows) {
            await this.dataSource!.rpc.executeQuery({
                sql,
                params: columns.map((c) => row[c] as unknown),
            })
        }
    }

    /**
     * Return the greater of two watermark values, comparing numerically when
     * both values are numeric and lexically otherwise.
     */
    private maxWatermark(
        current: string | null,
        value: SqlStorageValue
    ): string {
        const next = String(value)
        if (current === null) return next

        const currentNum = Number(current)
        const nextNum = Number(next)
        if (!Number.isNaN(currentNum) && !Number.isNaN(nextNum)) {
            return nextNum > currentNum ? next : current
        }

        return next > current ? next : current
    }

    public async getStatus(): Promise<ReplicationStateRow[]> {
        if (!this.dataSource) {
            throw new Error('ReplicationPlugin not properly initialized')
        }

        return (await this.dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.GET_ALL_STATE,
            params: [],
        })) as ReplicationStateRow[]
    }
}
