import { StarbaseApp, StarbaseDBConfiguration } from '../../src/handler'
import { StarbasePlugin } from '../../src/plugin'
import { executeQuery } from '../../src/operation'
import { DataSource, QueryResult } from '../../src/types'
import { createResponse } from '../../src/utils'

const SQL_QUERIES = {
    CREATE_TABLE: `
        CREATE TABLE IF NOT EXISTS tmp_replicator_tables (
            table_name TEXT NOT NULL UNIQUE PRIMARY KEY,
            source_schema TEXT,
            tracking_column TEXT NOT NULL,
            last_value TEXT,
            interval_seconds INTEGER NOT NULL DEFAULT 300,
            batch_size INTEGER NOT NULL DEFAULT 1000,
            is_active INTEGER NOT NULL DEFAULT 1,
            last_synced_at TEXT
        )
    `,
    UPSERT_TABLE: `
        INSERT INTO tmp_replicator_tables
            (table_name, source_schema, tracking_column, interval_seconds, batch_size, is_active)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(table_name) DO UPDATE SET
            source_schema = excluded.source_schema,
            tracking_column = excluded.tracking_column,
            interval_seconds = excluded.interval_seconds,
            batch_size = excluded.batch_size,
            is_active = excluded.is_active
    `,
    GET_TABLES: `SELECT * FROM tmp_replicator_tables`,
    GET_TABLE: `SELECT * FROM tmp_replicator_tables WHERE table_name = ?`,
    DELETE_TABLE: `DELETE FROM tmp_replicator_tables WHERE table_name = ?`,
    UPDATE_PROGRESS: `
        UPDATE tmp_replicator_tables
        SET last_value = ?, last_synced_at = datetime('now')
        WHERE table_name = ?
    `,
}

export interface ReplicatedTable {
    table_name: string
    source_schema: string | null
    tracking_column: string
    last_value: string | null
    interval_seconds: number
    batch_size: number
    is_active: number
    last_synced_at: string | null
}

export interface ReplicationResult {
    table: string
    rowsReplicated: number
    lastValue: string | null
    error?: string
}

/**
 * ReplicatorPlugin pulls data from a configured external data source (e.g. a
 * Postgres database on Supabase) into the internal Durable Object SQLite so
 * the instance can serve as a close-to-edge replica.
 *
 * Replication is append-only: for each registered table the user defines a
 * monotonically increasing `tracking_column` (e.g. `id` or `created_at`). On
 * each sync the plugin pulls rows where `tracking_column` is greater than the
 * last value it observed and upserts them into the internal table.
 */
export class ReplicatorPlugin extends StarbasePlugin {
    public pathPrefix: string = '/replicator'
    private dataSource?: DataSource
    private config?: StarbaseDBConfiguration
    // When true the plugin opportunistically syncs any table whose poll
    // interval has elapsed on incoming requests (edge-friendly pull cadence).
    private autoSyncOnRequest: boolean

    constructor(opts?: { autoSyncOnRequest?: boolean }) {
        super('starbasedb:replicator', {
            requiresAuth: true,
        })
        this.autoSyncOnRequest = opts?.autoSyncOnRequest ?? true
    }

    override async register(app: StarbaseApp) {
        app.use(async (c, next) => {
            this.dataSource = c?.get('dataSource')
            this.config = c?.get('config')
            await this.init()

            if (this.autoSyncOnRequest) {
                const due = this.syncDueTables()
                if (this.dataSource?.executionContext) {
                    this.dataSource.executionContext.waitUntil(due)
                } else {
                    await due
                }
            }

            await next()
        })

        // List the tables configured for replication.
        app.get(this.pathPrefix + '/tables', async (c) => {
            if (this.config?.role !== 'admin') {
                return createResponse(undefined, 'Unauthorized request', 401)
            }

            const tables = await this.listTables()
            return createResponse({ tables }, undefined, 200)
        })

        // Register (or update) a table for replication.
        app.post(this.pathPrefix + '/tables', async (c) => {
            if (this.config?.role !== 'admin') {
                return createResponse(undefined, 'Unauthorized request', 401)
            }

            try {
                const body = (await c.req.json()) as {
                    table?: string
                    schema?: string
                    trackingColumn?: string
                    intervalSeconds?: number
                    batchSize?: number
                    isActive?: boolean
                }

                if (!body.table || !body.trackingColumn) {
                    return createResponse(
                        undefined,
                        '`table` and `trackingColumn` are required',
                        400
                    )
                }

                await this.registerTable({
                    table: body.table,
                    schema: body.schema,
                    trackingColumn: body.trackingColumn,
                    intervalSeconds: body.intervalSeconds,
                    batchSize: body.batchSize,
                    isActive: body.isActive,
                })

                return createResponse({ success: true }, undefined, 200)
            } catch (error: any) {
                return createResponse(
                    undefined,
                    error?.message ?? 'Failed to register table',
                    400
                )
            }
        })

        // Remove a table from replication.
        app.delete(this.pathPrefix + '/tables/:table', async (c) => {
            if (this.config?.role !== 'admin') {
                return createResponse(undefined, 'Unauthorized request', 401)
            }

            await this.dataSource?.rpc.executeQuery({
                sql: SQL_QUERIES.DELETE_TABLE,
                params: [c.req.param('table')],
            })

            return createResponse({ success: true }, undefined, 200)
        })

        // Trigger a sync immediately. Optionally scope it to a single table
        // via `?table=` so external schedulers (Cron Triggers, the cron
        // plugin, etc.) can drive replication cadence.
        app.post(this.pathPrefix + '/sync', async (c) => {
            if (this.config?.role !== 'admin') {
                return createResponse(undefined, 'Unauthorized request', 401)
            }

            const table = c.req.query('table')
            const results = await this.sync(table)
            return createResponse({ results }, undefined, 200)
        })
    }

    private async init() {
        if (!this.dataSource) return

        await this.dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.CREATE_TABLE,
            params: [],
        })
    }

    public async listTables(): Promise<ReplicatedTable[]> {
        if (!this.dataSource) return []

        const result = (await this.dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.GET_TABLES,
            params: [],
        })) as QueryResult[]

        return (result ?? []) as unknown as ReplicatedTable[]
    }

    public async registerTable(opts: {
        table: string
        schema?: string
        trackingColumn: string
        intervalSeconds?: number
        batchSize?: number
        isActive?: boolean
    }) {
        if (!this.dataSource)
            throw new Error('ReplicatorPlugin not properly initialized')

        await this.dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.UPSERT_TABLE,
            params: [
                opts.table,
                opts.schema ?? null,
                opts.trackingColumn,
                opts.intervalSeconds ?? 300,
                opts.batchSize ?? 1000,
                opts.isActive === false ? 0 : 1,
            ],
        })
    }

    /**
     * Quote a SQL identifier for the given dialect. MySQL uses backticks,
     * every other supported dialect uses double quotes.
     */
    quoteIdentifier(name: string, dialect?: string): string {
        if (dialect === 'mysql') {
            return '`' + name.replace(/`/g, '``') + '`'
        }
        return '"' + name.replace(/"/g, '""') + '"'
    }

    /**
     * Render a value as a SQL literal. Numbers are emitted bare, everything
     * else is single-quoted with embedded quotes escaped. Used only for the
     * tracking-column watermark which originates from previously synced data.
     */
    quoteLiteral(value: unknown): string {
        if (value === null || value === undefined) return 'NULL'
        if (typeof value === 'number' && Number.isFinite(value)) {
            return String(value)
        }
        return `'${String(value).replace(/'/g, "''")}'`
    }

    /**
     * Build the SELECT statement issued against the external data source for
     * a given table configuration.
     */
    buildSelectQuery(table: ReplicatedTable, dialect?: string): string {
        const trackingColumn = this.quoteIdentifier(
            table.tracking_column,
            dialect
        )
        const qualifiedName = table.source_schema
            ? `${this.quoteIdentifier(table.source_schema, dialect)}.${this.quoteIdentifier(table.table_name, dialect)}`
            : this.quoteIdentifier(table.table_name, dialect)

        const where =
            table.last_value !== null && table.last_value !== undefined
                ? ` WHERE ${trackingColumn} > ${this.quoteLiteral(table.last_value)}`
                : ''

        return `SELECT * FROM ${qualifiedName}${where} ORDER BY ${trackingColumn} ASC LIMIT ${Number(table.batch_size) || 1000}`
    }

    /**
     * Build an `INSERT OR REPLACE` statement that upserts a single external
     * row into the internal SQLite table.
     */
    buildUpsertQuery(
        tableName: string,
        row: Record<string, unknown>
    ): { sql: string; params: unknown[] } {
        const columns = Object.keys(row)
        const quotedColumns = columns.map((c) => this.quoteIdentifier(c))
        const placeholders = columns.map(() => '?')

        return {
            sql: `INSERT OR REPLACE INTO ${this.quoteIdentifier(tableName)} (${quotedColumns.join(', ')}) VALUES (${placeholders.join(', ')})`,
            params: columns.map((c) => row[c]),
        }
    }

    private async queryExternalSource(sql: string): Promise<any[]> {
        if (!this.dataSource?.external) {
            throw new Error('No external data source is configured')
        }

        // Reuse the shared query pipeline but force the external/hyperdrive
        // path regardless of which source the incoming request targeted.
        const externalDataSource: DataSource = {
            ...this.dataSource,
            source:
                'connectionString' in this.dataSource.external
                    ? 'hyperdrive'
                    : 'external',
        }

        const result = await executeQuery({
            sql,
            params: undefined,
            isRaw: false,
            dataSource: externalDataSource,
            config: this.config ?? ({ role: 'admin' } as any),
        })

        return Array.isArray(result) ? result : []
    }

    /**
     * Replicate a single configured table and return how many rows were
     * pulled into the internal database.
     */
    async syncTable(table: ReplicatedTable): Promise<ReplicationResult> {
        if (!this.dataSource) {
            throw new Error('ReplicatorPlugin not properly initialized')
        }

        const dialect = this.dataSource.external?.dialect
        const selectQuery = this.buildSelectQuery(table, dialect)
        const rows = (await this.queryExternalSource(selectQuery)) as Record<
            string,
            unknown
        >[]

        let lastValue = table.last_value

        for (const row of rows) {
            const { sql, params } = this.buildUpsertQuery(table.table_name, row)
            await this.dataSource.rpc.executeQuery({ sql, params })

            const trackingValue = row[table.tracking_column]
            if (trackingValue !== undefined && trackingValue !== null) {
                lastValue = String(trackingValue)
            }
        }

        // Persist the new watermark so the next sync is append-only.
        await this.dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.UPDATE_PROGRESS,
            params: [lastValue ?? null, table.table_name],
        })

        return {
            table: table.table_name,
            rowsReplicated: rows.length,
            lastValue: lastValue ?? null,
        }
    }

    /**
     * Sync every active table, or just the named table when provided.
     */
    async sync(tableName?: string | null): Promise<ReplicationResult[]> {
        if (!this.dataSource) return []

        const tables = await this.listTables()
        const results: ReplicationResult[] = []

        for (const table of tables) {
            if (tableName && table.table_name !== tableName) continue
            if (!tableName && !table.is_active) continue

            try {
                results.push(await this.syncTable(table))
            } catch (error: any) {
                console.error(
                    `Replicator failed to sync table ${table.table_name}:`,
                    error
                )
                results.push({
                    table: table.table_name,
                    rowsReplicated: 0,
                    lastValue: table.last_value,
                    error: error?.message ?? String(error),
                })
            }
        }

        return results
    }

    /**
     * Returns true when a table's poll interval has elapsed since its last
     * successful sync (or it has never synced).
     */
    isDue(table: ReplicatedTable, now: number = Date.now()): boolean {
        if (!table.is_active) return false
        if (!table.last_synced_at) return true

        // `last_synced_at` is stored as a UTC datetime string.
        const lastSynced = Date.parse(table.last_synced_at + 'Z')
        if (Number.isNaN(lastSynced)) return true

        return now - lastSynced >= (Number(table.interval_seconds) || 0) * 1000
    }

    /**
     * Sync any active table whose poll interval has elapsed.
     */
    async syncDueTables(): Promise<ReplicationResult[]> {
        if (!this.dataSource?.external) return []

        const now = Date.now()
        const tables = await this.listTables()
        const results: ReplicationResult[] = []

        for (const table of tables) {
            if (!this.isDue(table, now)) continue

            try {
                results.push(await this.syncTable(table))
            } catch (error: any) {
                console.error(
                    `Replicator failed to sync table ${table.table_name}:`,
                    error
                )
            }
        }

        return results
    }
}
