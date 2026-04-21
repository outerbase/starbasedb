import { StarbaseApp, StarbaseDBConfiguration } from '../../src/handler'
import { StarbasePlugin } from '../../src/plugin'
import { DataSource, QueryResult } from '../../src/types'
import { createResponse } from '../../src/utils'

const SQL_QUERIES = {
    CREATE_CONFIG_TABLE: `
        CREATE TABLE IF NOT EXISTS tmp_pg_replication_config (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_table TEXT NOT NULL,
            target_table TEXT NOT NULL,
            source_schema TEXT NOT NULL DEFAULT 'public',
            primary_key TEXT NOT NULL DEFAULT 'id',
            sync_interval_ms INTEGER NOT NULL DEFAULT 60000,
            last_synced_at TEXT,
            last_synced_cursor TEXT,
            is_active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(source_table, source_schema)
        )
    `,
    CREATE_SYNC_LOG_TABLE: `
        CREATE TABLE IF NOT EXISTS tmp_pg_replication_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            config_id INTEGER NOT NULL,
            sync_type TEXT NOT NULL,
            rows_synced INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'pending',
            error_message TEXT,
            started_at TEXT NOT NULL DEFAULT (datetime('now')),
            completed_at TEXT,
            FOREIGN KEY (config_id) REFERENCES tmp_pg_replication_config(id)
        )
    `,
    INSERT_CONFIG: `
        INSERT INTO tmp_pg_replication_config (source_table, target_table, source_schema, primary_key, sync_interval_ms)
        VALUES (?, ?, ?, ?, ?)
    `,
    GET_ALL_CONFIGS: `
        SELECT id, source_table, target_table, source_schema, primary_key,
               sync_interval_ms, last_synced_at, last_synced_cursor, is_active
        FROM tmp_pg_replication_config
    `,
    GET_ACTIVE_CONFIGS: `
        SELECT id, source_table, target_table, source_schema, primary_key,
               sync_interval_ms, last_synced_at, last_synced_cursor
        FROM tmp_pg_replication_config
        WHERE is_active = 1
    `,
    GET_CONFIG_BY_ID: `
        SELECT id, source_table, target_table, source_schema, primary_key,
               sync_interval_ms, last_synced_at, last_synced_cursor, is_active
        FROM tmp_pg_replication_config
        WHERE id = ?
    `,
    UPDATE_SYNC_CURSOR: `
        UPDATE tmp_pg_replication_config
        SET last_synced_at = datetime('now'), last_synced_cursor = ?
        WHERE id = ?
    `,
    SET_CONFIG_ACTIVE: `
        UPDATE tmp_pg_replication_config SET is_active = ? WHERE id = ?
    `,
    DELETE_CONFIG: `
        DELETE FROM tmp_pg_replication_config WHERE id = ?
    `,
    INSERT_SYNC_LOG: `
        INSERT INTO tmp_pg_replication_log (config_id, sync_type, status)
        VALUES (?, ?, 'running')
    `,
    UPDATE_SYNC_LOG_SUCCESS: `
        UPDATE tmp_pg_replication_log
        SET status = 'success', rows_synced = ?, completed_at = datetime('now')
        WHERE id = ?
    `,
    UPDATE_SYNC_LOG_ERROR: `
        UPDATE tmp_pg_replication_log
        SET status = 'error', error_message = ?, completed_at = datetime('now')
        WHERE id = ?
    `,
    GET_RECENT_LOGS: `
        SELECT l.id, l.config_id, l.sync_type, l.rows_synced, l.status,
               l.error_message, l.started_at, l.completed_at,
               c.source_table, c.target_table
        FROM tmp_pg_replication_log l
        JOIN tmp_pg_replication_config c ON c.id = l.config_id
        ORDER BY l.started_at DESC
        LIMIT ?
    `,
}

export interface ReplicationConfig {
    id: number
    source_table: string
    target_table: string
    source_schema: string
    primary_key: string
    sync_interval_ms: number
    last_synced_at: string | null
    last_synced_cursor: string | null
    is_active: number
}

export interface SyncEventPayload {
    configId: number
    sourceTable: string
    targetTable: string
    syncType: 'full' | 'incremental'
    rowsSynced: number
    status: 'success' | 'error'
    error?: string
}

export class PostgresReplicationPlugin extends StarbasePlugin {
    public pathPrefix: string = '/replication'
    private dataSource?: DataSource
    private config?: StarbaseDBConfiguration
    private syncTimers: Map<number, ReturnType<typeof setTimeout>> = new Map()
    private eventCallbacks: ((payload: SyncEventPayload) => void)[] = []
    private initialized = false

    constructor(opts?: { pathPrefix?: string }) {
        super('starbasedb:postgres-replication', {
            requiresAuth: true,
        })
        this.pathPrefix = opts?.pathPrefix ?? this.pathPrefix
    }

    override async register(app: StarbaseApp) {
        app.use(async (c, next) => {
            this.dataSource = c?.get('dataSource')
            this.config = c?.get('config')
            if (!this.initialized) {
                await this.init()
                this.initialized = true
            }
            await next()
        })

        // List all replication configs
        app.get(this.pathPrefix, async (c) => {
            if (this.config?.role !== 'admin') {
                return createResponse(
                    { error: 'Unauthorized' },
                    undefined,
                    401
                )
            }
            const configs = await this.getAllConfigs()
            return createResponse({ configs }, undefined, 200)
        })

        // Add a new replication config
        app.post(this.pathPrefix, async (c) => {
            if (this.config?.role !== 'admin') {
                return createResponse(
                    { error: 'Unauthorized' },
                    undefined,
                    401
                )
            }

            const body = await c.req.json()
            const {
                sourceTable,
                targetTable,
                sourceSchema = 'public',
                primaryKey = 'id',
                syncIntervalMs = 60000,
            } = body

            if (!sourceTable || !targetTable) {
                return createResponse(
                    { error: 'sourceTable and targetTable are required' },
                    undefined,
                    400
                )
            }

            try {
                await this.addReplicationConfig({
                    sourceTable,
                    targetTable,
                    sourceSchema,
                    primaryKey,
                    syncIntervalMs,
                })
                return createResponse({ success: true }, undefined, 201)
            } catch (error: any) {
                return createResponse(
                    { error: error.message },
                    undefined,
                    500
                )
            }
        })

        // Trigger a manual sync for a specific config
        app.post(`${this.pathPrefix}/:id/sync`, async (c) => {
            if (this.config?.role !== 'admin') {
                return createResponse(
                    { error: 'Unauthorized' },
                    undefined,
                    401
                )
            }

            const id = parseInt(c.req.param('id'), 10)
            const body = await c.req.json().catch(() => ({}))
            const syncType = body.type === 'full' ? 'full' : 'incremental'

            try {
                const result = await this.syncTable(id, syncType)
                return createResponse(result, undefined, 200)
            } catch (error: any) {
                return createResponse(
                    { error: error.message },
                    undefined,
                    500
                )
            }
        })

        // Pause/resume a replication config
        app.patch(`${this.pathPrefix}/:id`, async (c) => {
            if (this.config?.role !== 'admin') {
                return createResponse(
                    { error: 'Unauthorized' },
                    undefined,
                    401
                )
            }

            const id = parseInt(c.req.param('id'), 10)
            const body = await c.req.json()

            if (typeof body.isActive === 'boolean') {
                await this.setConfigActive(id, body.isActive ? 1 : 0)
                return createResponse({ success: true }, undefined, 200)
            }

            return createResponse(
                { error: 'No valid fields to update' },
                undefined,
                400
            )
        })

        // Delete a replication config
        app.delete(`${this.pathPrefix}/:id`, async (c) => {
            if (this.config?.role !== 'admin') {
                return createResponse(
                    { error: 'Unauthorized' },
                    undefined,
                    401
                )
            }

            const id = parseInt(c.req.param('id'), 10)
            await this.deleteConfig(id)
            return createResponse({ success: true }, undefined, 200)
        })

        // Get sync logs
        app.get(`${this.pathPrefix}/logs`, async (c) => {
            if (this.config?.role !== 'admin') {
                return createResponse(
                    { error: 'Unauthorized' },
                    undefined,
                    401
                )
            }

            const limit = parseInt(c.req.query('limit') || '50', 10)
            const logs = await this.getRecentLogs(limit)
            return createResponse({ logs }, undefined, 200)
        })
    }

    private async init() {
        if (!this.dataSource) return

        await this.dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.CREATE_CONFIG_TABLE,
            params: [],
        })
        await this.dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.CREATE_SYNC_LOG_TABLE,
            params: [],
        })
    }

    public async getAllConfigs(): Promise<ReplicationConfig[]> {
        if (!this.dataSource) return []
        const result = (await this.dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.GET_ALL_CONFIGS,
            params: [],
        })) as QueryResult[]
        return result as unknown as ReplicationConfig[]
    }

    public async getConfigById(
        id: number
    ): Promise<ReplicationConfig | null> {
        if (!this.dataSource) return null
        const result = (await this.dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.GET_CONFIG_BY_ID,
            params: [id],
        })) as QueryResult[]
        return (result[0] as unknown as ReplicationConfig) ?? null
    }

    public async addReplicationConfig(opts: {
        sourceTable: string
        targetTable: string
        sourceSchema?: string
        primaryKey?: string
        syncIntervalMs?: number
    }): Promise<void> {
        if (!this.dataSource) throw new Error('Plugin not initialized')

        await this.dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.INSERT_CONFIG,
            params: [
                opts.sourceTable,
                opts.targetTable,
                opts.sourceSchema ?? 'public',
                opts.primaryKey ?? 'id',
                opts.syncIntervalMs ?? 60000,
            ],
        })
    }

    public async setConfigActive(id: number, active: number): Promise<void> {
        if (!this.dataSource) return

        await this.dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.SET_CONFIG_ACTIVE,
            params: [active, id],
        })
    }

    public async deleteConfig(id: number): Promise<void> {
        if (!this.dataSource) return

        // Stop any running sync timer
        const timer = this.syncTimers.get(id)
        if (timer) {
            clearTimeout(timer)
            this.syncTimers.delete(id)
        }

        await this.dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.DELETE_CONFIG,
            params: [id],
        })
    }

    public async getRecentLogs(limit: number = 50): Promise<QueryResult[]> {
        if (!this.dataSource) return []

        return (await this.dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.GET_RECENT_LOGS,
            params: [limit],
        })) as QueryResult[]
    }

    /**
     * Sync a single table from the external PostgreSQL source into local SQLite.
     * Supports full (truncate + reload) and incremental (cursor-based) sync.
     */
    public async syncTable(
        configId: number,
        syncType: 'full' | 'incremental' = 'incremental'
    ): Promise<{
        rowsSynced: number
        syncType: string
        status: string
        error?: string
    }> {
        if (!this.dataSource) {
            throw new Error('Plugin not initialized')
        }

        if (
            this.dataSource.source !== 'external' ||
            !this.dataSource.external
        ) {
            throw new Error(
                'No external PostgreSQL data source configured. ' +
                    'This plugin requires an external data source with dialect "postgresql".'
            )
        }

        const external = this.dataSource.external
        if (!('dialect' in external) || external.dialect !== 'postgresql') {
            throw new Error(
                'External data source must use the "postgresql" dialect.'
            )
        }

        const config = await this.getConfigById(configId)
        if (!config) {
            throw new Error(`Replication config with id ${configId} not found`)
        }

        // Create sync log entry
        const logResult = (await this.dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.INSERT_SYNC_LOG,
            params: [configId, syncType],
        })) as any
        const logId = logResult?.lastRowId ?? logResult?.last_insert_rowid ?? 0

        try {
            let rowsSynced = 0

            if (syncType === 'full') {
                rowsSynced = await this.fullSync(config)
            } else {
                rowsSynced = await this.incrementalSync(config)
            }

            // Update sync log
            await this.dataSource.rpc.executeQuery({
                sql: SQL_QUERIES.UPDATE_SYNC_LOG_SUCCESS,
                params: [rowsSynced, logId],
            })

            const payload: SyncEventPayload = {
                configId,
                sourceTable: config.source_table,
                targetTable: config.target_table,
                syncType,
                rowsSynced,
                status: 'success',
            }
            this.emitEvent(payload)

            return { rowsSynced, syncType, status: 'success' }
        } catch (error: any) {
            await this.dataSource.rpc.executeQuery({
                sql: SQL_QUERIES.UPDATE_SYNC_LOG_ERROR,
                params: [error.message, logId],
            })

            const payload: SyncEventPayload = {
                configId,
                sourceTable: config.source_table,
                targetTable: config.target_table,
                syncType,
                rowsSynced: 0,
                status: 'error',
                error: error.message,
            }
            this.emitEvent(payload)

            return { rowsSynced: 0, syncType, status: 'error', error: error.message }
        }
    }

    /**
     * Full sync: reads all rows from the source table and upserts them into
     * the local target table, replacing any existing data.
     */
    private async fullSync(config: ReplicationConfig): Promise<number> {
        if (!this.dataSource) throw new Error('Plugin not initialized')

        const qualifiedSource = `"${config.source_schema}"."${config.source_table}"`

        // Fetch all rows from the external PostgreSQL source.
        // The query is executed against the external data source by the framework
        // when dataSource.source is 'external'.
        const rows = (await this.dataSource.rpc.executeQuery({
            sql: `SELECT * FROM ${qualifiedSource} ORDER BY "${config.primary_key}" ASC`,
            params: [],
        })) as QueryResult[]

        if (!rows || rows.length === 0) {
            await this.dataSource.rpc.executeQuery({
                sql: SQL_QUERIES.UPDATE_SYNC_CURSOR,
                params: [null, config.id],
            })
            return 0
        }

        // Derive column list from the first row
        const columns = Object.keys(rows[0])
        const placeholders = columns.map(() => '?').join(', ')
        const columnList = columns.map((c) => `"${c}"`).join(', ')

        // Build upsert statement for local SQLite target
        const upsertSql = `
            INSERT OR REPLACE INTO "${config.target_table}" (${columnList})
            VALUES (${placeholders})
        `

        // Insert row by row (safe for large sets in SQLite)
        for (const row of rows) {
            const values = columns.map((col) => row[col] ?? null)
            await this.dataSource.rpc.executeQuery({
                sql: upsertSql,
                params: values,
            })
        }

        // Update cursor to the max primary key seen
        const lastRow = rows[rows.length - 1]
        const cursor = String(lastRow[config.primary_key] ?? '')

        await this.dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.UPDATE_SYNC_CURSOR,
            params: [cursor, config.id],
        })

        return rows.length
    }

    /**
     * Incremental sync: reads only rows newer than the last synced cursor
     * (based on primary key comparison) and upserts them locally.
     */
    private async incrementalSync(config: ReplicationConfig): Promise<number> {
        if (!this.dataSource) throw new Error('Plugin not initialized')

        const qualifiedSource = `"${config.source_schema}"."${config.source_table}"`
        let fetchSql: string
        let fetchParams: unknown[]

        if (config.last_synced_cursor) {
            fetchSql = `SELECT * FROM ${qualifiedSource} WHERE "${config.primary_key}" > $1 ORDER BY "${config.primary_key}" ASC`
            fetchParams = [config.last_synced_cursor]
        } else {
            // No cursor yet, fall back to full sync
            return this.fullSync(config)
        }

        const rows = (await this.dataSource.rpc.executeQuery({
            sql: fetchSql,
            params: fetchParams,
        })) as QueryResult[]

        if (!rows || rows.length === 0) {
            return 0
        }

        const columns = Object.keys(rows[0])
        const placeholders = columns.map(() => '?').join(', ')
        const columnList = columns.map((c) => `"${c}"`).join(', ')

        const upsertSql = `
            INSERT OR REPLACE INTO "${config.target_table}" (${columnList})
            VALUES (${placeholders})
        `

        for (const row of rows) {
            const values = columns.map((col) => row[col] ?? null)
            await this.dataSource.rpc.executeQuery({
                sql: upsertSql,
                params: values,
            })
        }

        const lastRow = rows[rows.length - 1]
        const cursor = String(lastRow[config.primary_key] ?? '')

        await this.dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.UPDATE_SYNC_CURSOR,
            params: [cursor, config.id],
        })

        return rows.length
    }

    /**
     * Register a callback to receive sync event notifications.
     */
    public onEvent(
        callback: (payload: SyncEventPayload) => void | Promise<void>,
        ctx?: ExecutionContext
    ) {
        const wrappedCallback = async (payload: SyncEventPayload) => {
            const result = callback(payload)
            if (result instanceof Promise && ctx) {
                ctx.waitUntil(result)
            }
        }
        this.eventCallbacks.push(wrappedCallback)
    }

    private emitEvent(payload: SyncEventPayload) {
        this.eventCallbacks.forEach((callback) => {
            try {
                callback(payload)
            } catch (error) {
                console.error(
                    'Error in postgres-replication event callback:',
                    error
                )
            }
        })
    }
}
