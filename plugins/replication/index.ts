import { StarbaseApp, StarbaseDBConfiguration } from '../../src/handler'
import { StarbasePlugin } from '../../src/plugin'
import { DataSource, QueryResult } from '../../src/types'
import { createResponse } from '../../src/utils'
import { executeExternalQuery } from '../../src/operation'

export interface ReplicationConfig {
    /** Tables to replicate. Empty array means all tables from external source. */
    tables?: string[]
    /** Column to use as cursor for incremental sync (e.g. 'id' or 'created_at') */
    cursorColumn?: string
    /** Rows to fetch per batch. Default: 500 */
    batchSize?: number
    /** Cloudflare ExecutionContext for waitUntil support */
    ctx?: ExecutionContext
}

const DEFAULT_BATCH_SIZE = 500
const DEFAULT_CURSOR_COLUMN = 'id'

const SQL_QUERIES = {
    CREATE_CHECKPOINT_TABLE: `
        CREATE TABLE IF NOT EXISTS tmp_replication_checkpoints (
            table_name TEXT NOT NULL PRIMARY KEY,
            cursor_column TEXT NOT NULL,
            last_cursor_value TEXT,
            last_synced_at DATETIME,
            rows_synced INTEGER DEFAULT 0
        )
    `,
    GET_ALL_CHECKPOINTS: `SELECT * FROM tmp_replication_checkpoints`,
    GET_CHECKPOINT: `SELECT * FROM tmp_replication_checkpoints WHERE table_name = ?`,
    UPSERT_CHECKPOINT: `
        INSERT OR REPLACE INTO tmp_replication_checkpoints
            (table_name, cursor_column, last_cursor_value, last_synced_at, rows_synced)
        VALUES (?, ?, ?, datetime('now'), ?)
    `,
    GET_EXTERNAL_TABLES: `
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `,
}

export class ReplicationPlugin extends StarbasePlugin {
    public pathPrefix: string = '/replication'
    private dataSource?: DataSource
    private config?: StarbaseDBConfiguration
    private executionContext?: ExecutionContext
    private readonly replicationConfig: Required<Omit<ReplicationConfig, 'ctx'>>

    constructor(opts?: ReplicationConfig) {
        super('starbasedb:replication', { requiresAuth: true })
        this.replicationConfig = {
            tables: opts?.tables ?? [],
            cursorColumn: opts?.cursorColumn ?? DEFAULT_CURSOR_COLUMN,
            batchSize: opts?.batchSize ?? DEFAULT_BATCH_SIZE,
        }
        this.executionContext = opts?.ctx
    }

    override async register(app: StarbaseApp): Promise<void> {
        app.use(async (c, next) => {
            this.dataSource = c.get('dataSource')
            this.config = c.get('config')
            await this.dataSource?.rpc.executeQuery({
                sql: SQL_QUERIES.CREATE_CHECKPOINT_TABLE,
                params: [],
            })
            await next()
        })

        app.get(`${this.pathPrefix}/status`, async (c) => {
            const config = c.get('config')
            if (config?.role !== 'admin') {
                return createResponse(undefined, 'Unauthorized', 401)
            }

            const checkpoints = (await this.dataSource?.rpc.executeQuery({
                sql: SQL_QUERIES.GET_ALL_CHECKPOINTS,
                params: [],
            })) as QueryResult[]

            return createResponse(
                {
                    checkpoints: checkpoints ?? [],
                    config: this.replicationConfig,
                },
                undefined,
                200
            )
        })

        app.post(`${this.pathPrefix}/run`, async (c) => {
            const config = c.get('config')
            if (config?.role !== 'admin') {
                return createResponse(undefined, 'Unauthorized', 401)
            }

            this.executionContext?.waitUntil(this.sync())

            return createResponse(
                { success: true, message: 'Replication started' },
                undefined,
                200
            )
        })
    }

    // Table and column names are structural identifiers, not user-supplied values;
    // cursor value and batch size are safely parameterized with `?` placeholders.
    private buildFetchQuery(
        table: string,
        cursorColumn: string,
        lastCursorValue: string | null,
        batchSize: number
    ): { sql: string; params: unknown[] } {
        if (lastCursorValue !== null && lastCursorValue !== undefined) {
            return {
                sql: `SELECT * FROM ${table} WHERE ${cursorColumn} > ? ORDER BY ${cursorColumn} ASC LIMIT ?`,
                params: [lastCursorValue, batchSize],
            }
        }

        return {
            sql: `SELECT * FROM ${table} ORDER BY ${cursorColumn} ASC LIMIT ?`,
            params: [batchSize],
        }
    }

    private inferSQLiteType(columnName: string): string {
        if (columnName === 'id' || columnName.endsWith('_id')) {
            return 'INTEGER'
        }

        return 'TEXT'
    }

    private sanitizeIdentifier(identifier: string): string {
        if (!/^[A-Za-z0-9_]+$/.test(identifier)) {
            throw new Error(
                `[replication] Invalid identifier "${identifier}". Only alphanumeric characters and underscores are allowed.`
            )
        }

        return identifier
    }

    private async sync(): Promise<void> {
        if (!this.dataSource || !this.config) {
            console.warn('[replication] Plugin not properly initialized.')
            return
        }

        if (this.dataSource.external?.dialect !== 'postgresql') {
            console.warn(
                '[replication] Only PostgreSQL external sources are supported. Skipping sync.'
            )
            return
        }

        const tables = await this.getTablesToSync()

        for (const table of tables) {
            try {
                await this.syncTable(table)
            } catch (error) {
                console.error(
                    `[replication] Error syncing table "${table}":`,
                    error
                )
            }
        }
    }

    private async getTablesToSync(): Promise<string[]> {
        if (this.replicationConfig.tables.length > 0) {
            return this.replicationConfig.tables
        }

        const rows = (await executeExternalQuery({
            sql: SQL_QUERIES.GET_EXTERNAL_TABLES,
            params: [],
            dataSource: this.dataSource!,
            config: this.config!,
        })) as QueryResult[]

        return rows.map((row) => row['table_name'] as string)
    }

    private async syncTable(table: string): Promise<void> {
        const { cursorColumn, batchSize } = this.replicationConfig

        const checkpointRows = (await this.dataSource!.rpc.executeQuery({
            sql: SQL_QUERIES.GET_CHECKPOINT,
            params: [table],
        })) as QueryResult[]

        const checkpoint = checkpointRows?.[0]
        const lastCursorValue =
            (checkpoint?.last_cursor_value as string | null) ?? null

        const { sql, params } = this.buildFetchQuery(
            table,
            cursorColumn,
            lastCursorValue,
            batchSize
        )

        const rows = (await executeExternalQuery({
            sql,
            params,
            dataSource: this.dataSource!,
            config: this.config!,
        })) as QueryResult[]

        if (!rows || rows.length === 0) {
            console.log(`[replication] No new rows for table "${table}"`)
            return
        }

        const firstRow = rows[0]
        const firstRowColumns = Object.keys(firstRow)

        if (firstRowColumns.length === 0) {
            throw new Error(
                `[replication] Cannot sync table "${table}" because the first row has no columns.`
            )
        }

        const safeTableName = this.sanitizeIdentifier(table)
        const safeCursorColumn = this.sanitizeIdentifier(cursorColumn)
        const createTableColumns = firstRowColumns
            .map((columnName) => {
                const safeColumnName = this.sanitizeIdentifier(columnName)
                return `${safeColumnName} ${this.inferSQLiteType(columnName)}`
            })
            .join(', ')

        await this.dataSource!.rpc.executeQuery({
            sql: `CREATE TABLE IF NOT EXISTS ${safeTableName} (${createTableColumns}, PRIMARY KEY (${safeCursorColumn}))`,
            params: [],
        })

        for (const row of rows) {
            const columns = Object.keys(row)
            const safeColumns = columns.map((columnName) =>
                this.sanitizeIdentifier(columnName)
            )
            const placeholders = safeColumns.map(() => '?').join(', ')
            const values = columns.map((col) => row[col])

            // Table name and column names are structural identifiers from the
            // external schema; row values are safely parameterized.
            await this.dataSource!.rpc.executeQuery({
                sql: `INSERT OR REPLACE INTO ${safeTableName} (${safeColumns.join(', ')}) VALUES (${placeholders})`,
                params: values,
            })
        }

        const lastRow = rows[rows.length - 1]
        const newCursorValue = String(lastRow[cursorColumn] ?? '')
        const previousRowsSynced = (checkpoint?.rows_synced as number) ?? 0
        const totalRowsSynced = previousRowsSynced + rows.length

        await this.dataSource!.rpc.executeQuery({
            sql: SQL_QUERIES.UPSERT_CHECKPOINT,
            params: [table, cursorColumn, newCursorValue, totalRowsSynced],
        })

        console.log(`[replication] synced ${rows.length} rows from "${table}"`)
    }
}
