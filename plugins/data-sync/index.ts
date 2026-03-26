import { StarbaseApp, StarbaseDBConfiguration } from '../../src/handler'
import { StarbasePlugin } from '../../src/plugin'
import { DataSource } from '../../src/types'
import { createResponse } from '../../src/utils'
import { executeExternalQuery } from '../../src/operation'
import type { SyncAdapter } from './adapter'
import type {
    DataSyncConfig,
    SyncMetadata,
    SyncTableConfig,
    ColumnDefinition,
} from './types'

/**
 * Internal table names – following the project convention of prefixing
 * system tables with `tmp_` so users can distinguish them from their own.
 */
const META_TABLE = 'tmp_data_sync_metadata'
const LOG_TABLE = 'tmp_data_sync_log'

const SQL = {
    CREATE_META: `
        CREATE TABLE IF NOT EXISTS ${META_TABLE} (
            table_name    TEXT PRIMARY KEY,
            last_cursor   TEXT,
            last_synced   TEXT NOT NULL,
            rows_synced   INTEGER NOT NULL DEFAULT 0
        )
    `,
    CREATE_LOG: `
        CREATE TABLE IF NOT EXISTS ${LOG_TABLE} (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            table_name  TEXT NOT NULL,
            status      TEXT NOT NULL,
            rows_synced INTEGER NOT NULL DEFAULT 0,
            error       TEXT,
            started_at  TEXT NOT NULL,
            finished_at TEXT
        )
    `,
    GET_META: `SELECT * FROM ${META_TABLE} WHERE table_name = ?`,
    UPSERT_META: `
        INSERT OR REPLACE INTO ${META_TABLE} (table_name, last_cursor, last_synced, rows_synced)
        VALUES (?, ?, datetime('now'), ?)
    `,
    INSERT_LOG: `
        INSERT INTO ${LOG_TABLE} (table_name, status, rows_synced, error, started_at, finished_at)
        VALUES (?, ?, ?, ?, ?, ?)
    `,
    GET_ALL_META: `SELECT * FROM ${META_TABLE}`,
    GET_RECENT_LOGS: `SELECT * FROM ${LOG_TABLE} ORDER BY id DESC LIMIT 50`,
} as const

export interface DataSyncPluginOptions {
    /** The database-specific adapter to use for fetching data */
    adapter: SyncAdapter
    /** Replication configuration */
    config: DataSyncConfig
}

/**
 * DataSyncPlugin – replicates data from an external database source into the
 * internal Durable Object SQLite store, turning a StarbaseDB instance into a
 * close-to-edge read-replica.
 *
 * Design principles:
 * - **Adapter pattern** – all database-specific logic lives in a `SyncAdapter`
 *   subclass.  The plugin itself is source-agnostic.
 * - **Incremental sync** – when a `cursorColumn` is specified for a table the
 *   plugin only pulls rows newer than the last sync checkpoint.
 * - **Scheduled execution** – uses Durable Object alarms via the existing cron
 *   infrastructure to run sync cycles at a configurable interval.
 * - **Observability** – every sync run is logged in `tmp_data_sync_log` and
 *   surfaced through a status endpoint.
 */
export class DataSyncPlugin extends StarbasePlugin {
    public pathPrefix: string = '/sync'
    private adapter: SyncAdapter
    private syncConfig: DataSyncConfig
    private dataSource?: DataSource
    private dbConfig?: StarbaseDBConfiguration
    private syncInProgress = false

    constructor(opts: DataSyncPluginOptions) {
        super('starbasedb:data-sync', { requiresAuth: true })
        this.adapter = opts.adapter
        this.syncConfig = {
            intervalMs: 60_000,
            batchSize: 1000,
            ...opts.config,
        }
    }

    // ------------------------------------------------------------------
    // Plugin lifecycle
    // ------------------------------------------------------------------

    override async register(app: StarbaseApp) {
        // Middleware: capture data source + config from Hono context on every
        // request so they are available to route handlers and the sync engine.
        app.use(async (c, next) => {
            this.dataSource = c.get('dataSource')
            this.dbConfig = c.get('config')
            await this.initTables()
            await next()
        })

        // ---- Admin-only API routes ----

        /** GET /sync/status – return metadata and recent logs */
        app.get(`${this.pathPrefix}/status`, async () => {
            if (this.dbConfig?.role !== 'admin') {
                return createResponse(undefined, 'Unauthorized', 401)
            }
            const meta = await this.queryInternal(SQL.GET_ALL_META)
            const logs = await this.queryInternal(SQL.GET_RECENT_LOGS)
            return createResponse(
                { tables: meta, recentLogs: logs },
                undefined,
                200
            )
        })

        /** POST /sync/trigger – manually trigger a sync cycle */
        app.post(`${this.pathPrefix}/trigger`, async () => {
            if (this.dbConfig?.role !== 'admin') {
                return createResponse(undefined, 'Unauthorized', 401)
            }
            if (this.syncInProgress) {
                return createResponse(
                    { message: 'Sync already in progress' },
                    undefined,
                    409
                )
            }
            const results = await this.runSyncCycle()
            return createResponse({ results }, undefined, 200)
        })
    }

    // ------------------------------------------------------------------
    // Internal helpers
    // ------------------------------------------------------------------

    private async initTables() {
        if (!this.dataSource) return
        await this.dataSource.rpc.executeQuery({ sql: SQL.CREATE_META })
        await this.dataSource.rpc.executeQuery({ sql: SQL.CREATE_LOG })
    }

    /**
     * Execute a query against the internal Durable Object SQLite store.
     */
    private async queryInternal(
        sql: string,
        params?: unknown[]
    ): Promise<Record<string, unknown>[]> {
        if (!this.dataSource) throw new Error('DataSyncPlugin not initialized')
        return (await this.dataSource.rpc.executeQuery({
            sql,
            params,
        })) as Record<string, unknown>[]
    }

    /**
     * Execute a query against the external data source using the SDK.
     */
    private async queryExternal(
        sql: string
    ): Promise<Record<string, unknown>[]> {
        if (!this.dataSource || !this.dbConfig) {
            throw new Error('DataSyncPlugin not initialized')
        }
        if (!this.dataSource.external) {
            throw new Error('No external data source configured')
        }

        const result = await executeExternalQuery({
            sql,
            params: [],
            dataSource: {
                ...this.dataSource,
                source: 'external',
            },
            config: this.dbConfig,
        })

        return Array.isArray(result) ? result : []
    }

    // ------------------------------------------------------------------
    // Sync engine
    // ------------------------------------------------------------------

    /**
     * Run a full sync cycle across all configured tables.
     */
    public async runSyncCycle(): Promise<
        { table: string; status: string; rowsSynced: number; error?: string }[]
    > {
        if (this.syncInProgress) return []
        this.syncInProgress = true

        const results: {
            table: string
            status: string
            rowsSynced: number
            error?: string
        }[] = []

        try {
            for (const tableConfig of this.syncConfig.tables) {
                const result = await this.syncTable(tableConfig)
                results.push(result)
            }
        } finally {
            this.syncInProgress = false
        }

        return results
    }

    /**
     * Sync a single table from the external source into the internal store.
     */
    private async syncTable(tableConfig: SyncTableConfig): Promise<{
        table: string
        status: string
        rowsSynced: number
        error?: string
    }> {
        const targetTable = this.adapter.resolveTargetTable(tableConfig)
        const startedAt = new Date().toISOString()
        let totalRowsSynced = 0

        try {
            // 1. Retrieve last sync checkpoint
            const metaRows = await this.queryInternal(SQL.GET_META, [
                targetTable,
            ])
            const meta =
                metaRows.length > 0
                    ? (metaRows[0] as unknown as SyncMetadata)
                    : null
            let cursor = meta?.lastCursorValue ?? null

            // 2. Ensure the target table exists in the internal store
            await this.ensureTargetTable(tableConfig, targetTable)

            // 3. Fetch rows in batches
            const batchSize = this.syncConfig.batchSize ?? 1000
            let hasMore = true

            while (hasMore) {
                const { rows } = await this.adapter.fetchRows(
                    tableConfig,
                    (sql) => this.queryExternal(sql),
                    cursor,
                    batchSize
                )

                if (rows.length === 0) {
                    hasMore = false
                    break
                }

                // 4. Upsert rows into the internal store
                await this.upsertRows(targetTable, rows, tableConfig)
                totalRowsSynced += rows.length

                // 5. Advance cursor
                if (tableConfig.cursorColumn) {
                    const lastRow = rows[rows.length - 1]
                    const newCursor = lastRow[tableConfig.cursorColumn]
                    cursor = newCursor != null ? String(newCursor) : cursor
                }

                // If fewer rows than batch size, no more pages
                if (rows.length < batchSize) {
                    hasMore = false
                }
            }

            // 6. Persist metadata checkpoint
            await this.queryInternal(SQL.UPSERT_META, [
                targetTable,
                cursor,
                totalRowsSynced,
            ])

            // 7. Log success
            await this.queryInternal(SQL.INSERT_LOG, [
                targetTable,
                'success',
                totalRowsSynced,
                null,
                startedAt,
                new Date().toISOString(),
            ])

            return {
                table: targetTable,
                status: 'success',
                rowsSynced: totalRowsSynced,
            }
        } catch (err: any) {
            const errorMsg = err?.message ?? String(err)

            await this.queryInternal(SQL.INSERT_LOG, [
                targetTable,
                'error',
                totalRowsSynced,
                errorMsg,
                startedAt,
                new Date().toISOString(),
            ]).catch(() => {
                // If even logging fails, swallow to avoid masking original error.
            })

            return {
                table: targetTable,
                status: 'error',
                rowsSynced: totalRowsSynced,
                error: errorMsg,
            }
        }
    }

    /**
     * Auto-create the target table in the internal SQLite store if it does
     * not already exist.  Uses the adapter to introspect the external schema
     * and maps column types to SQLite equivalents.
     */
    private async ensureTargetTable(
        tableConfig: SyncTableConfig,
        targetTable: string
    ) {
        // Quick check: if the table already exists, skip schema introspection.
        try {
            await this.queryInternal(`SELECT 1 FROM "${targetTable}" LIMIT 0`)
            return
        } catch {
            // Table does not exist — continue to create it.
        }

        const columns = await this.adapter.fetchTableSchema(
            tableConfig,
            (sql) => this.queryExternal(sql)
        )

        if (columns.length === 0) {
            throw new Error(
                `Could not introspect schema for ${tableConfig.sourceTable}`
            )
        }

        const columnDefs = columns
            .map(
                (col) =>
                    `"${col.name}" ${this.adapter.mapToSQLiteType(col.sourceType)}`
            )
            .join(', ')

        await this.queryInternal(
            `CREATE TABLE IF NOT EXISTS "${targetTable}" (${columnDefs})`
        )
    }

    /**
     * Insert or replace rows into the internal SQLite table.
     *
     * When a `cursorColumn` is configured the plugin uses INSERT OR REPLACE so
     * that re-synced rows are updated rather than duplicated.  For tables
     * without a cursor column, the plugin clears and repopulates on each
     * cycle (full replacement strategy).
     */
    private async upsertRows(
        targetTable: string,
        rows: Record<string, unknown>[],
        tableConfig: SyncTableConfig
    ) {
        if (rows.length === 0) return

        // If no cursor column, full replacement on first batch
        if (!tableConfig.cursorColumn) {
            await this.queryInternal(`DELETE FROM "${targetTable}"`)
        }

        const columns = Object.keys(rows[0])
        const placeholders = columns.map(() => '?').join(', ')
        const columnList = columns.map((c) => `"${c}"`).join(', ')
        const insertSQL = `INSERT OR REPLACE INTO "${targetTable}" (${columnList}) VALUES (${placeholders})`

        for (const row of rows) {
            const values = columns.map((col) => {
                const val = row[col]
                // SQLite cannot store objects/arrays directly – serialise to JSON.
                if (val !== null && typeof val === 'object') {
                    return JSON.stringify(val)
                }
                return val ?? null
            })

            await this.queryInternal(insertSQL, values)
        }
    }
}
