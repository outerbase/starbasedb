import { StarbaseApp, StarbaseDBConfiguration } from '../../src/handler'
import { StarbasePlugin } from '../../src/plugin'
import { DataSource } from '../../src/types'
import { executeExternalQuery } from '../../src/operation'
import { createResponse } from '../../src/utils'
import { CronPlugin } from '../cron'
import { PostgresSyncAdapter } from './adapters/postgres'
import { MySQLSyncAdapter } from './adapters/mysql'
import { GenericSyncAdapter } from './adapters/generic'
import type { SyncAdapter } from './adapter'
import type {
    ReplicationConfig,
    ReplicationState,
    SyncResult,
    TableReplicationConfig,
} from './types'

export function createSyncAdapter(dialect: string): SyncAdapter {
    switch (dialect.toLowerCase()) {
        case 'postgresql':
        case 'postgres':
            return new PostgresSyncAdapter()
        case 'mysql':
            return new MySQLSyncAdapter()
        default:
            return new GenericSyncAdapter()
    }
}

const DEFAULT_BATCH_SIZE = 1000
const DEFAULT_SYNC_INTERVAL_MS = 60 * 1000
const CRON_TASK_NAME = 'starbasedb:replication:sync'

const SQL = {
    CREATE_STATE_TABLE: `
        CREATE TABLE IF NOT EXISTS tmp_replication_state (
            source_table      TEXT PRIMARY KEY,
            target_table      TEXT NOT NULL,
            last_cursor_value TEXT,
            last_sync_at      TEXT,
            rows_synced       INTEGER DEFAULT 0,
            total_rows_synced INTEGER DEFAULT 0,
            status            TEXT DEFAULT 'idle',
            error_message     TEXT,
            updated_at        TEXT DEFAULT (datetime('now'))
        )
    `,
    CREATE_HISTORY_TABLE: `
        CREATE TABLE IF NOT EXISTS tmp_replication_history (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            source_table  TEXT NOT NULL,
            target_table  TEXT NOT NULL,
            rows_synced   INTEGER NOT NULL,
            duration_ms   INTEGER NOT NULL,
            status        TEXT NOT NULL,
            error_message TEXT,
            started_at    TEXT NOT NULL,
            completed_at  TEXT DEFAULT (datetime('now'))
        )
    `,
    GET_ALL_STATE: `
        SELECT source_table, target_table, last_cursor_value, last_sync_at,
               rows_synced, total_rows_synced, status, error_message, updated_at
        FROM tmp_replication_state
        ORDER BY source_table ASC
    `,
    GET_STATE: `
        SELECT source_table, target_table, last_cursor_value, last_sync_at,
               rows_synced, total_rows_synced, status, error_message, updated_at
        FROM tmp_replication_state
        WHERE source_table = ?
    `,
    UPSERT_STATE: `
        INSERT INTO tmp_replication_state (
            source_table, target_table, last_cursor_value, last_sync_at,
            rows_synced, total_rows_synced, status, error_message, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(source_table) DO UPDATE SET
            target_table      = excluded.target_table,
            last_cursor_value = excluded.last_cursor_value,
            last_sync_at      = excluded.last_sync_at,
            rows_synced       = excluded.rows_synced,
            total_rows_synced = tmp_replication_state.total_rows_synced + excluded.rows_synced,
            status            = excluded.status,
            error_message     = excluded.error_message,
            updated_at        = datetime('now')
    `,
    UPDATE_STATUS: `
        UPDATE tmp_replication_state
        SET status = ?, error_message = ?, updated_at = datetime('now')
        WHERE source_table = ?
    `,
    RESET_CHECKPOINT: `
        UPDATE tmp_replication_state
        SET last_cursor_value = NULL, rows_synced = 0, total_rows_synced = 0,
            status = 'idle', error_message = NULL, updated_at = datetime('now')
        WHERE source_table = ?
    `,
    INSERT_HISTORY: `
        INSERT INTO tmp_replication_history (
            source_table, target_table, rows_synced, duration_ms, status, error_message, started_at, completed_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `,
    GET_HISTORY: `
        SELECT id, source_table, target_table, rows_synced, duration_ms, status, error_message, started_at, completed_at
        FROM tmp_replication_history
        ORDER BY id DESC LIMIT 50
    `,
    GET_HISTORY_FOR_TABLE: `
        SELECT id, source_table, target_table, rows_synced, duration_ms, status, error_message, started_at, completed_at
        FROM tmp_replication_history
        WHERE source_table = ?
        ORDER BY id DESC LIMIT 50
    `,
}

export class DataReplicationPlugin extends StarbasePlugin {
    public pathPrefix: string = '/replication'
    private config: ReplicationConfig
    private cronPlugin?: CronPlugin
    private dataSource?: DataSource
    private pluginConfig?: StarbaseDBConfiguration
    private cronRegistered = false

    constructor(opts: {
        config: ReplicationConfig
        cronPlugin?: CronPlugin
        pathPrefix?: string
    }) {
        super(
            'starbasedb:replication',
            { requiresAuth: true },
            opts.pathPrefix || '/replication'
        )
        this.config = opts.config
        this.cronPlugin = opts.cronPlugin
        if (opts.pathPrefix) {
            this.pathPrefix = opts.pathPrefix
        }
    }

    override async register(app: StarbaseApp) {
        app.use(async (c, next) => {
            this.dataSource = c.get('dataSource')
            this.pluginConfig = c.get('config')
            await this.init()
            await this.maybeScheduleLazySync()
            await next()
        })

        app.get(`${this.pathPrefix}/status`, async (c) => {
            if (this.pluginConfig?.role !== 'admin') {
                return createResponse(undefined, 'Unauthorized', 401)
            }

            const rows = (await this.dataSource?.rpc.executeQuery({
                sql: SQL.GET_ALL_STATE,
                params: [],
            })) as unknown as ReplicationState[]

            return createResponse(rows ?? [], undefined, 200)
        })

        app.get(`${this.pathPrefix}/status/:table`, async (c) => {
            if (this.pluginConfig?.role !== 'admin') {
                return createResponse(undefined, 'Unauthorized', 401)
            }

            const table = c.req.param('table')
            const rows = (await this.dataSource?.rpc.executeQuery({
                sql: SQL.GET_STATE,
                params: [table],
            })) as unknown as ReplicationState[]

            if (!rows || rows.length === 0) {
                return createResponse(undefined, 'Table state not found', 404)
            }

            return createResponse(rows[0], undefined, 200)
        })

        app.post(`${this.pathPrefix}/sync`, async (c) => {
            if (this.pluginConfig?.role !== 'admin') {
                return createResponse(undefined, 'Unauthorized', 401)
            }

            if (!this.dataSource) {
                return createResponse(undefined, 'Data source unavailable', 503)
            }

            const ds = this.dataSource
            const cfg = this.pluginConfig
            const syncPromise = this.syncAll(ds, cfg)
            ds.executionContext?.waitUntil(syncPromise) ?? syncPromise

            return createResponse(
                { message: 'Sync triggered for all tables' },
                undefined,
                202
            )
        })

        app.post(`${this.pathPrefix}/sync/:table`, async (c) => {
            if (this.pluginConfig?.role !== 'admin') {
                return createResponse(undefined, 'Unauthorized', 401)
            }

            if (!this.dataSource) {
                return createResponse(undefined, 'Data source unavailable', 503)
            }

            const tableName = c.req.param('table')
            const tableConfig = this.config.tables.find(
                (t) => t.sourceTable === tableName
            )

            if (!tableConfig) {
                return createResponse(
                    undefined,
                    `Table '${tableName}' not found in replication config`,
                    404
                )
            }

            const ds = this.dataSource
            const cfg = this.pluginConfig
            const syncPromise = this.syncTable(tableConfig, ds, cfg)
            ds.executionContext?.waitUntil(syncPromise) ?? syncPromise

            return createResponse(
                { message: `Sync triggered for table '${tableName}'` },
                undefined,
                202
            )
        })

        app.delete(`${this.pathPrefix}/state/:table`, async (c) => {
            if (this.pluginConfig?.role !== 'admin') {
                return createResponse(undefined, 'Unauthorized', 401)
            }

            const table = c.req.param('table')
            await this.dataSource?.rpc.executeQuery({
                sql: SQL.RESET_CHECKPOINT,
                params: [table],
            })

            return createResponse(
                { message: `Checkpoint reset for '${table}'` },
                undefined,
                200
            )
        })

        app.get(`${this.pathPrefix}/history`, async (c) => {
            if (this.pluginConfig?.role !== 'admin') {
                return createResponse(undefined, 'Unauthorized', 401)
            }

            const rows = await this.dataSource?.rpc.executeQuery({
                sql: SQL.GET_HISTORY,
                params: [],
            })

            return createResponse(rows ?? [], undefined, 200)
        })

        app.get(`${this.pathPrefix}/history/:table`, async (c) => {
            if (this.pluginConfig?.role !== 'admin') {
                return createResponse(undefined, 'Unauthorized', 401)
            }

            const table = c.req.param('table')
            const rows = await this.dataSource?.rpc.executeQuery({
                sql: SQL.GET_HISTORY_FOR_TABLE,
                params: [table],
            })

            return createResponse(rows ?? [], undefined, 200)
        })

        if (this.cronPlugin && this.config.cronSchedule) {
            this.cronPlugin.onEvent(async ({ name }) => {
                if (name !== CRON_TASK_NAME || !this.dataSource) return
                await this.syncAll(this.dataSource, this.pluginConfig)
            })
        }
    }

    override async beforeQuery(opts: {
        sql: string
        params?: unknown[]
        isRaw: boolean
        dataSource?: DataSource
        config?: StarbaseDBConfiguration
    }): Promise<{ sql: string; params?: unknown[] }> {
        let sql = opts.sql
        if (!sql) return { sql, params: opts.params }

        for (const tableConfig of this.config.tables) {
            const schema = tableConfig.schema ?? 'public'
            const source = tableConfig.sourceTable
            const target =
                tableConfig.targetTable ??
                (schema ? `${schema}_${source}` : source)

            // Matches schema.sourceTable with optional double quotes or backticks,
            // e.g. public.users, "public"."users", `public`.`users`, "public".users, public."users"
            const schemaQualifiedRegex = new RegExp(
                `["\`]?${schema}["\`]?\\s*\\.\\s*["\`]?${source}["\`]?`,
                'gi'
            )
            sql = sql.replace(schemaQualifiedRegex, `"${target}"`)
        }

        return {
            sql,
            params: opts.params,
        }
    }

    private async init() {
        if (!this.dataSource) return

        await this.dataSource.rpc.executeQuery({
            sql: SQL.CREATE_STATE_TABLE,
            params: [],
        })

        await this.dataSource.rpc.executeQuery({
            sql: SQL.CREATE_HISTORY_TABLE,
            params: [],
        })

        if (
            !this.cronRegistered &&
            this.cronPlugin &&
            this.config.cronSchedule &&
            this.config.callbackHost
        ) {
            try {
                await this.cronPlugin.addEvent(
                    this.config.cronSchedule,
                    CRON_TASK_NAME,
                    {},
                    this.config.callbackHost
                )
                this.cronRegistered = true
            } catch {
                // Task may already exist; safe to ignore.
            }
        }
    }

    private async maybeScheduleLazySync() {
        if (this.cronPlugin || !this.config.syncIntervalMs) return
        if (!this.dataSource) return

        const intervalMs =
            this.config.syncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS

        const rows = (await this.dataSource.rpc.executeQuery({
            sql: `SELECT MIN(last_sync_at) AS earliest FROM tmp_replication_state`,
            params: [],
        })) as unknown as { earliest: string | null }[]

        const earliest = rows?.[0]?.earliest
        if (!earliest) {
            return
        }

        const lastSyncMs = new Date(earliest).getTime()
        if (Date.now() - lastSyncMs > intervalMs) {
            const ds = this.dataSource
            const cfg = this.pluginConfig
            const syncPromise = this.syncAll(ds, cfg)
            ds.executionContext?.waitUntil(syncPromise) ?? syncPromise
        }
    }

    async syncAll(
        dataSource: DataSource,
        config?: StarbaseDBConfiguration
    ): Promise<SyncResult[]> {
        const results: SyncResult[] = []

        for (const tableConfig of this.config.tables) {
            try {
                const result = await this.syncTable(
                    tableConfig,
                    dataSource,
                    config
                )
                results.push(result)
            } catch (err) {
                // Isolated error handling: a failure in one table must not crash syncAll
                const errorMessage =
                    err instanceof Error ? err.message : String(err)
                results.push({
                    table: tableConfig.sourceTable,
                    targetTable:
                        tableConfig.targetTable ?? tableConfig.sourceTable,
                    rowsSynced: 0,
                    durationMs: 0,
                    success: false,
                    error: errorMessage,
                })
            }
        }

        return results
    }

    async syncTable(
        tableConfig: TableReplicationConfig,
        dataSource: DataSource,
        config?: StarbaseDBConfiguration
    ): Promise<SyncResult> {
        const schema =
            tableConfig.schema ??
            (dataSource?.external && 'defaultSchema' in dataSource.external
                ? (dataSource.external.defaultSchema ?? 'public')
                : 'public')

        const dialect =
            dataSource?.external && 'dialect' in dataSource.external
                ? dataSource.external.dialect
                : 'sqlite'

        const adapter = createSyncAdapter(dialect)
        const targetTable = adapter.resolveTargetTableName(
            tableConfig.sourceTable,
            schema,
            tableConfig.targetTable
        )

        if (!dataSource?.external) {
            return {
                table: tableConfig.sourceTable,
                targetTable,
                rowsSynced: 0,
                durationMs: 0,
                success: false,
                error: 'No external data source configured',
            }
        }

        const conflictStrategy = tableConfig.conflictStrategy ?? 'replace'
        const batchSize = this.config.batchSize ?? DEFAULT_BATCH_SIZE
        const startedAt = new Date().toISOString()
        const startMs = Date.now()
        let totalSynced = 0

        await this.setStatus(
            dataSource,
            tableConfig.sourceTable,
            targetTable,
            'running'
        )

        try {
            const existingState = await this.getState(
                dataSource,
                tableConfig.sourceTable,
                targetTable
            )

            // Auto schema creation on first sync
            if (!existingState || existingState.last_cursor_value === null) {
                const introspect = adapter.buildIntrospectQuery(
                    tableConfig.sourceTable,
                    schema
                )

                const introspectRows = (await executeExternalQuery({
                    sql: introspect.sql,
                    params: introspect.params,
                    dataSource,
                    config: config ?? { role: 'admin' },
                })) as Record<string, unknown>[]

                if (introspectRows && introspectRows.length > 0) {
                    const columnDefs =
                        adapter.parseIntrospectResult(introspectRows)
                    const createSQL = adapter.buildCreateTableSQL(
                        targetTable,
                        columnDefs,
                        tableConfig.cursorColumn
                    )
                    await dataSource.rpc.executeQuery({
                        sql: createSQL,
                        params: [],
                    })
                }
            }

            let cursorValue = existingState?.last_cursor_value ?? null

            while (true) {
                const fetchQuery = adapter.buildFetchQuery({
                    table: tableConfig.sourceTable,
                    schema,
                    cursorColumn: tableConfig.cursorColumn,
                    cursorValue,
                    cursorType: tableConfig.cursorType,
                    columns: tableConfig.columns,
                    limit: batchSize,
                })

                const rows = (await executeExternalQuery({
                    sql: fetchQuery.sql,
                    params: fetchQuery.params,
                    dataSource,
                    config: config ?? { role: 'admin' },
                })) as Record<string, unknown>[]

                if (!rows || rows.length === 0) {
                    break
                }

                const columnNames = Object.keys(rows[0])
                const upsertSQL = adapter.buildUpsertSQL(
                    targetTable,
                    columnNames,
                    conflictStrategy
                )

                for (let i = 0; i < rows.length; i++) {
                    const values = columnNames.map((col) => {
                        const val = rows[i][col]
                        if (val !== null && typeof val === 'object') {
                            return JSON.stringify(val)
                        }
                        return val ?? null
                    })

                    await dataSource.rpc.executeQuery({
                        sql: upsertSQL,
                        params: values,
                    })

                    // Yield event loop every 100 rows to prevent DO starvation
                    if (i > 0 && i % 100 === 0) {
                        await new Promise<void>((resolve) =>
                            setTimeout(resolve, 0)
                        )
                    }
                }

                const lastRow = rows[rows.length - 1]
                cursorValue = String(lastRow[tableConfig.cursorColumn])
                totalSynced += rows.length

                await dataSource.rpc.executeQuery({
                    sql: SQL.UPSERT_STATE,
                    params: [
                        tableConfig.sourceTable,
                        targetTable,
                        cursorValue,
                        new Date().toISOString(),
                        rows.length,
                        'running',
                        null,
                    ],
                })

                if (rows.length < batchSize) {
                    break
                }
            }

            const durationMs = Date.now() - startMs

            await dataSource.rpc.executeQuery({
                sql: SQL.UPSERT_STATE,
                params: [
                    tableConfig.sourceTable,
                    targetTable,
                    cursorValue,
                    new Date().toISOString(),
                    0,
                    'success',
                    null,
                ],
            })

            await dataSource.rpc.executeQuery({
                sql: SQL.INSERT_HISTORY,
                params: [
                    tableConfig.sourceTable,
                    targetTable,
                    totalSynced,
                    durationMs,
                    'success',
                    null,
                    startedAt,
                ],
            })

            return {
                table: tableConfig.sourceTable,
                targetTable,
                rowsSynced: totalSynced,
                durationMs,
                success: true,
            }
        } catch (err) {
            const errorMessage =
                err instanceof Error ? err.message : String(err)
            const durationMs = Date.now() - startMs

            await this.setStatus(
                dataSource,
                tableConfig.sourceTable,
                targetTable,
                'error',
                errorMessage
            )

            await dataSource.rpc.executeQuery({
                sql: SQL.INSERT_HISTORY,
                params: [
                    tableConfig.sourceTable,
                    targetTable,
                    0,
                    durationMs,
                    'error',
                    errorMessage,
                    startedAt,
                ],
            })

            console.error(
                `[replication] sync failed for '${tableConfig.sourceTable}':`,
                errorMessage
            )

            return {
                table: tableConfig.sourceTable,
                targetTable,
                rowsSynced: 0,
                durationMs,
                success: false,
                error: errorMessage,
            }
        }
    }

    private async getState(
        dataSource: DataSource,
        sourceTable: string,
        targetTable: string
    ): Promise<ReplicationState | null> {
        const rows = (await dataSource.rpc.executeQuery({
            sql: SQL.GET_STATE,
            params: [sourceTable],
        })) as unknown as ReplicationState[]

        if (rows && rows.length > 0) return rows[0]

        await dataSource.rpc.executeQuery({
            sql: `INSERT OR IGNORE INTO tmp_replication_state (source_table, target_table) VALUES (?, ?)`,
            params: [sourceTable, targetTable],
        })

        return null
    }

    private async setStatus(
        dataSource: DataSource,
        sourceTable: string,
        targetTable: string,
        status: string,
        errorMessage?: string
    ) {
        const existing = (await dataSource.rpc.executeQuery({
            sql: `SELECT source_table FROM tmp_replication_state WHERE source_table = ?`,
            params: [sourceTable],
        })) as unknown as { source_table: string }[]

        if (!existing || existing.length === 0) {
            await dataSource.rpc.executeQuery({
                sql: `INSERT INTO tmp_replication_state (source_table, target_table, status, error_message)
                      VALUES (?, ?, ?, ?)`,
                params: [
                    sourceTable,
                    targetTable,
                    status,
                    errorMessage ?? null,
                ],
            })
        } else {
            await dataSource.rpc.executeQuery({
                sql: SQL.UPDATE_STATUS,
                params: [status, errorMessage ?? null, sourceTable],
            })
        }
    }
}
