import { StarbaseDBDurableObject } from '../../src'
import { StarbaseApp, StarbaseDBConfiguration } from '../../src/handler'
import { StarbasePlugin } from '../../src/plugin'
import { DataSource, QueryResult } from '../../src/types'
import { createResponse } from '../../src/utils'
import { executeExternalQuery } from '../../src/operation'

// ── Interfaces ──────────────────────────────────────────────────────────────

export interface ReplicationConfig {
    id: number
    source_table: string
    target_table: string | null
    columns: string | null
    cursor_column: string | null
    interval_seconds: number
    enabled: number
    callback_host: string | null
    created_at: string
    updated_at: string
}

export interface SyncState {
    config_id: number
    last_cursor_value: string | null
    last_sync_at: string | null
    rows_synced: number
}

export interface SyncResult {
    configId: number
    rowsSynced: number
    lastCursorValue: string | null
    syncedAt: string
    error?: string
}

export interface ColumnDef {
    name: string
    type: string
    sqliteType: string
}

// ── SQL Constants ───────────────────────────────────────────────────────────

const SQL_QUERIES = {
    CREATE_CONFIGS_TABLE: `
        CREATE TABLE IF NOT EXISTS tmp_replication_configs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_table TEXT NOT NULL,
            target_table TEXT,
            columns TEXT,
            cursor_column TEXT,
            interval_seconds INTEGER NOT NULL CHECK(interval_seconds > 0),
            enabled INTEGER NOT NULL DEFAULT 1,
            callback_host TEXT,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        );
    `,
    CREATE_STATE_TABLE: `
        CREATE TABLE IF NOT EXISTS tmp_replication_state (
            config_id INTEGER PRIMARY KEY,
            last_cursor_value TEXT,
            last_sync_at TEXT,
            rows_synced INTEGER DEFAULT 0,
            FOREIGN KEY (config_id) REFERENCES tmp_replication_configs(id)
        );
    `,
}

// ── Plugin Class ────────────────────────────────────────────────────────────

export class DataReplicationPlugin extends StarbasePlugin {
    public pathPrefix: string = '/replication'
    private dataSource?: DataSource
    private config?: StarbaseDBConfiguration

    constructor(opts?: { stub?: DurableObjectStub<StarbaseDBDurableObject> }) {
        super('starbasedb:data-replication', {
            requiresAuth: true,
        })
    }

    // ── Initialization ──────────────────────────────────────────────────

    private async init(): Promise<void> {
        if (!this.dataSource) return

        await this.dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.CREATE_CONFIGS_TABLE,
            params: [],
        })
        await this.dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.CREATE_STATE_TABLE,
            params: [],
        })
    }

    // ── Type Mapping ────────────────────────────────────────────────────

    public mapToSQLiteType(externalType: string): string {
        const normalized = externalType
            .toLowerCase()
            .replace(/\(.*\)/, '')
            .trim()

        const integerTypes = [
            'integer',
            'int',
            'smallint',
            'bigint',
            'serial',
            'bigserial',
            'tinyint',
            'mediumint',
            'int2',
            'int4',
            'int8',
        ]
        const realTypes = [
            'real',
            'double',
            'float',
            'numeric',
            'decimal',
            'double precision',
            'float4',
            'float8',
        ]
        const blobTypes = [
            'bytea',
            'blob',
            'binary',
            'varbinary',
            'longblob',
            'mediumblob',
            'tinyblob',
        ]
        const boolTypes = ['boolean', 'bool']

        if (integerTypes.includes(normalized)) return 'INTEGER'
        if (realTypes.includes(normalized)) return 'REAL'
        if (blobTypes.includes(normalized)) return 'BLOB'
        if (boolTypes.includes(normalized)) return 'INTEGER'
        return 'TEXT'
    }

    // ── Schema Introspection ────────────────────────────────────────────

    public async introspectSchema(sourceTable: string): Promise<ColumnDef[]> {
        if (!this.dataSource || !this.config) {
            throw new Error('DataReplicationPlugin not properly initialized')
        }

        const dialect = this.dataSource.external?.dialect
        let rows: any[]

        if (dialect === 'postgresql') {
            const schema =
                (this.dataSource.external as any)?.defaultSchema || 'public'
            rows = await executeExternalQuery({
                sql: `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = ? AND table_schema = ? ORDER BY ordinal_position`,
                params: [sourceTable, schema],
                dataSource: this.dataSource,
                config: this.config,
            })
            return rows.map((r: any) => ({
                name: r.column_name,
                type: r.data_type,
                sqliteType: this.mapToSQLiteType(r.data_type),
            }))
        } else if (dialect === 'mysql') {
            const schema =
                (this.dataSource.external as any)?.defaultSchema ||
                (this.dataSource.external as any)?.database ||
                'public'
            rows = await executeExternalQuery({
                sql: `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = ? AND table_schema = ? ORDER BY ordinal_position`,
                params: [sourceTable, schema],
                dataSource: this.dataSource,
                config: this.config,
            })
            return rows.map((r: any) => ({
                name: r.column_name || r.COLUMN_NAME,
                type: r.data_type || r.DATA_TYPE,
                sqliteType: this.mapToSQLiteType(r.data_type || r.DATA_TYPE),
            }))
        } else {
            // SQLite / Turso / D1 / Starbase
            rows = await executeExternalQuery({
                sql: `PRAGMA table_info(${sourceTable})`,
                params: [],
                dataSource: this.dataSource,
                config: this.config,
            })
            return rows.map((r: any) => ({
                name: r.name,
                type: r.type || 'TEXT',
                sqliteType: this.mapToSQLiteType(r.type || 'TEXT'),
            }))
        }
    }

    public async ensureTargetTable(
        targetTable: string,
        columns: ColumnDef[]
    ): Promise<void> {
        if (!this.dataSource) return

        const colDefs = columns
            .map((c) => `"${c.name}" ${c.sqliteType}`)
            .join(', ')
        const sql = `CREATE TABLE IF NOT EXISTS "${targetTable}" (${colDefs})`
        await this.dataSource.rpc.executeQuery({ sql, params: [] })
    }

    // ── Core Sync Logic ─────────────────────────────────────────────────

    public async fetchExternalRows(
        config: ReplicationConfig,
        lastCursor: string | null
    ): Promise<any[]> {
        if (!this.dataSource || !this.config) {
            throw new Error('DataReplicationPlugin not properly initialized')
        }

        const cols = config.columns
            ? JSON.parse(config.columns).join(', ')
            : '*'
        let sql = `SELECT ${cols} FROM ${config.source_table}`
        const params: any[] = []

        if (config.cursor_column && lastCursor !== null) {
            sql += ` WHERE ${config.cursor_column} > ?`
            params.push(lastCursor)
        }

        if (config.cursor_column) {
            sql += ` ORDER BY ${config.cursor_column} ASC`
        }

        return await executeExternalQuery({
            sql,
            params,
            dataSource: this.dataSource,
            config: this.config,
        })
    }

    public async insertRows(
        targetTable: string,
        rows: any[],
        mode: 'incremental' | 'full'
    ): Promise<number> {
        if (!this.dataSource || rows.length === 0) return 0

        if (mode === 'full') {
            await this.dataSource.rpc.executeQuery({
                sql: `DELETE FROM "${targetTable}"`,
                params: [],
            })
        }

        let inserted = 0
        for (const row of rows) {
            const keys = Object.keys(row)
            const placeholders = keys.map(() => '?').join(', ')
            const values = keys.map((k) => row[k])
            const colNames = keys.map((k) => `"${k}"`).join(', ')

            const verb = mode === 'incremental' ? 'INSERT OR REPLACE' : 'INSERT'
            const sql = `${verb} INTO "${targetTable}" (${colNames}) VALUES (${placeholders})`
            await this.dataSource.rpc.executeQuery({ sql, params: values })
            inserted++
        }

        return inserted
    }

    public async updateSyncState(
        configId: number,
        lastCursor: string | null,
        rowsSynced: number
    ): Promise<void> {
        if (!this.dataSource) return

        await this.dataSource.rpc.executeQuery({
            sql: `INSERT OR REPLACE INTO tmp_replication_state (config_id, last_cursor_value, last_sync_at, rows_synced)
                  VALUES (?, ?, datetime('now'), ?)`,
            params: [configId, lastCursor, rowsSynced],
        })
    }

    public async syncConfig(configId: number): Promise<SyncResult> {
        if (!this.dataSource) {
            throw new Error('DataReplicationPlugin not properly initialized')
        }

        // Load config
        const configs = (await this.dataSource.rpc.executeQuery({
            sql: 'SELECT * FROM tmp_replication_configs WHERE id = ?',
            params: [configId],
        })) as ReplicationConfig[]

        if (!configs.length) {
            throw new Error(`Configuration ${configId} not found`)
        }

        const config = configs[0]
        const targetTable = config.target_table || config.source_table
        const mode: 'incremental' | 'full' = config.cursor_column
            ? 'incremental'
            : 'full'

        // Check if target table exists, if not introspect and create
        try {
            const tableCheck = (await this.dataSource.rpc.executeQuery({
                sql: `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
                params: [targetTable],
            })) as any[]

            if (!tableCheck.length) {
                const columns = await this.introspectSchema(config.source_table)
                await this.ensureTargetTable(targetTable, columns)
            }
        } catch (error) {
            console.error(
                `Schema introspection failed for config ${configId}:`,
                error
            )
            throw error
        }

        // Get last cursor value
        let lastCursor: string | null = null
        if (config.cursor_column) {
            const states = (await this.dataSource.rpc.executeQuery({
                sql: 'SELECT * FROM tmp_replication_state WHERE config_id = ?',
                params: [configId],
            })) as SyncState[]

            if (states.length && states[0].last_cursor_value !== null) {
                lastCursor = states[0].last_cursor_value
            }
        }

        // Fetch rows from external source
        const rows = await this.fetchExternalRows(config, lastCursor)

        // Insert rows
        const rowsSynced = await this.insertRows(targetTable, rows, mode)

        // Determine new cursor value
        let newCursor: string | null = lastCursor
        if (config.cursor_column && rows.length > 0) {
            const lastRow = rows[rows.length - 1]
            newCursor = String(lastRow[config.cursor_column])
        }

        // Update sync state
        await this.updateSyncState(configId, newCursor, rowsSynced)

        const syncedAt = new Date().toISOString()
        return {
            configId,
            rowsSynced,
            lastCursorValue: newCursor,
            syncedAt,
        }
    }

    // ── Alarm Scheduling ────────────────────────────────────────────────

    public async scheduleNextAlarm(): Promise<void> {
        if (!this.dataSource) return

        const configs = (await this.dataSource.rpc.executeQuery({
            sql: 'SELECT c.*, s.last_sync_at FROM tmp_replication_configs c LEFT JOIN tmp_replication_state s ON c.id = s.config_id WHERE c.enabled = 1',
            params: [],
        })) as (ReplicationConfig & { last_sync_at: string | null })[]

        if (!configs.length) return

        const now = Date.now()
        let earliestTime = Infinity

        for (const config of configs) {
            let nextSync: number
            if (config.last_sync_at) {
                const lastSyncMs = new Date(config.last_sync_at + 'Z').getTime()
                nextSync = lastSyncMs + config.interval_seconds * 1000
            } else {
                // Never synced — due immediately
                nextSync = now
            }

            if (nextSync < earliestTime) {
                earliestTime = nextSync
            }
        }

        if (earliestTime !== Infinity) {
            const alarmTime = Math.max(earliestTime, now + 1000)
            await this.dataSource.rpc.setAlarm(alarmTime)
        }
    }

    // ── Route Registration ──────────────────────────────────────────────

    override async register(app: StarbaseApp): Promise<void> {
        // Middleware: capture dataSource and config, init tables, schedule alarm
        app.use(`${this.pathPrefix}/*`, async (c, next) => {
            this.dataSource = c?.get('dataSource')
            this.config = c?.get('config')
            await this.init()
            await this.scheduleNextAlarm()
            await next()
        })

        // POST /replication/configs — create a new config
        app.post(`${this.pathPrefix}/configs`, async (c) => {
            try {
                const body = await c.req.json()

                if (
                    !body.source_table ||
                    typeof body.source_table !== 'string' ||
                    !body.source_table.trim()
                ) {
                    return createResponse(
                        undefined,
                        'source_table is required',
                        400
                    )
                }

                if (
                    body.interval_seconds === undefined ||
                    body.interval_seconds === null ||
                    !Number.isInteger(body.interval_seconds) ||
                    body.interval_seconds <= 0
                ) {
                    return createResponse(
                        undefined,
                        'interval_seconds must be a positive integer',
                        400
                    )
                }

                const sql = `INSERT INTO tmp_replication_configs (source_table, target_table, columns, cursor_column, interval_seconds, enabled, callback_host)
                             VALUES (?, ?, ?, ?, ?, ?, ?)`
                const params = [
                    body.source_table.trim(),
                    body.target_table || null,
                    body.columns ? JSON.stringify(body.columns) : null,
                    body.cursor_column || null,
                    body.interval_seconds,
                    body.enabled !== undefined ? (body.enabled ? 1 : 0) : 1,
                    body.callback_host || null,
                ]

                await this.dataSource!.rpc.executeQuery({ sql, params })

                // Retrieve the created config
                const created = (await this.dataSource!.rpc.executeQuery({
                    sql: 'SELECT * FROM tmp_replication_configs ORDER BY id DESC LIMIT 1',
                    params: [],
                })) as ReplicationConfig[]

                return createResponse(created[0], undefined, 200)
            } catch (error: any) {
                return createResponse(
                    undefined,
                    error?.message || 'Failed to create config',
                    500
                )
            }
        })

        // GET /replication/configs — list all configs
        app.get(`${this.pathPrefix}/configs`, async (c) => {
            const configs = (await this.dataSource!.rpc.executeQuery({
                sql: 'SELECT * FROM tmp_replication_configs',
                params: [],
            })) as ReplicationConfig[]

            return createResponse(configs, undefined, 200)
        })

        // GET /replication/configs/:id — get config by ID
        app.get(`${this.pathPrefix}/configs/:id`, async (c) => {
            const id = parseInt(c.req.param('id'), 10)
            const configs = (await this.dataSource!.rpc.executeQuery({
                sql: 'SELECT * FROM tmp_replication_configs WHERE id = ?',
                params: [id],
            })) as ReplicationConfig[]

            if (!configs.length) {
                return createResponse(undefined, 'Configuration not found', 404)
            }

            return createResponse(configs[0], undefined, 200)
        })

        // PUT /replication/configs/:id — update config
        app.put(`${this.pathPrefix}/configs/:id`, async (c) => {
            try {
                const id = parseInt(c.req.param('id'), 10)
                const body = await c.req.json()

                // Check existence
                const existing = (await this.dataSource!.rpc.executeQuery({
                    sql: 'SELECT * FROM tmp_replication_configs WHERE id = ?',
                    params: [id],
                })) as ReplicationConfig[]

                if (!existing.length) {
                    return createResponse(
                        undefined,
                        'Configuration not found',
                        404
                    )
                }

                const fields: string[] = []
                const params: any[] = []

                if (body.source_table !== undefined) {
                    fields.push('source_table = ?')
                    params.push(body.source_table)
                }
                if (body.target_table !== undefined) {
                    fields.push('target_table = ?')
                    params.push(body.target_table)
                }
                if (body.columns !== undefined) {
                    fields.push('columns = ?')
                    params.push(
                        body.columns ? JSON.stringify(body.columns) : null
                    )
                }
                if (body.cursor_column !== undefined) {
                    fields.push('cursor_column = ?')
                    params.push(body.cursor_column)
                }
                if (body.interval_seconds !== undefined) {
                    fields.push('interval_seconds = ?')
                    params.push(body.interval_seconds)
                }
                if (body.enabled !== undefined) {
                    fields.push('enabled = ?')
                    params.push(body.enabled ? 1 : 0)
                }
                if (body.callback_host !== undefined) {
                    fields.push('callback_host = ?')
                    params.push(body.callback_host)
                }

                if (fields.length > 0) {
                    fields.push("updated_at = datetime('now')")
                    params.push(id)
                    await this.dataSource!.rpc.executeQuery({
                        sql: `UPDATE tmp_replication_configs SET ${fields.join(', ')} WHERE id = ?`,
                        params,
                    })
                }

                const updated = (await this.dataSource!.rpc.executeQuery({
                    sql: 'SELECT * FROM tmp_replication_configs WHERE id = ?',
                    params: [id],
                })) as ReplicationConfig[]

                return createResponse(updated[0], undefined, 200)
            } catch (error: any) {
                return createResponse(
                    undefined,
                    error?.message || 'Failed to update config',
                    500
                )
            }
        })

        // DELETE /replication/configs/:id — delete config and sync state
        app.delete(`${this.pathPrefix}/configs/:id`, async (c) => {
            const id = parseInt(c.req.param('id'), 10)

            const existing = (await this.dataSource!.rpc.executeQuery({
                sql: 'SELECT * FROM tmp_replication_configs WHERE id = ?',
                params: [id],
            })) as ReplicationConfig[]

            if (!existing.length) {
                return createResponse(undefined, 'Configuration not found', 404)
            }

            await this.dataSource!.rpc.executeQuery({
                sql: 'DELETE FROM tmp_replication_state WHERE config_id = ?',
                params: [id],
            })
            await this.dataSource!.rpc.executeQuery({
                sql: 'DELETE FROM tmp_replication_configs WHERE id = ?',
                params: [id],
            })

            return createResponse({ success: true }, undefined, 200)
        })

        // GET /replication/status — all sync states
        app.get(`${this.pathPrefix}/status`, async (c) => {
            const states = (await this.dataSource!.rpc.executeQuery({
                sql: 'SELECT * FROM tmp_replication_state',
                params: [],
            })) as SyncState[]

            return createResponse(states, undefined, 200)
        })

        // GET /replication/status/:id — sync state for specific config
        app.get(`${this.pathPrefix}/status/:id`, async (c) => {
            const id = parseInt(c.req.param('id'), 10)
            const states = (await this.dataSource!.rpc.executeQuery({
                sql: 'SELECT * FROM tmp_replication_state WHERE config_id = ?',
                params: [id],
            })) as SyncState[]

            if (!states.length) {
                return createResponse(undefined, 'Sync state not found', 404)
            }

            return createResponse(states[0], undefined, 200)
        })

        // POST /replication/sync/:id — manually trigger sync
        app.post(`${this.pathPrefix}/sync/:id`, async (c) => {
            const id = parseInt(c.req.param('id'), 10)

            const configs = (await this.dataSource!.rpc.executeQuery({
                sql: 'SELECT * FROM tmp_replication_configs WHERE id = ?',
                params: [id],
            })) as ReplicationConfig[]

            if (!configs.length) {
                return createResponse(undefined, 'Configuration not found', 404)
            }

            try {
                const result = await this.syncConfig(id)
                return createResponse(result, undefined, 200)
            } catch (error: any) {
                return createResponse(
                    undefined,
                    error?.message || 'Sync failed',
                    500
                )
            }
        })

        // POST /replication/callback — internal alarm callback handler
        app.post(`${this.pathPrefix}/callback`, async (c) => {
            try {
                // Load enabled configs that are due for sync
                const now = new Date().toISOString()
                const configs = (await this.dataSource!.rpc.executeQuery({
                    sql: `SELECT c.* FROM tmp_replication_configs c
                          LEFT JOIN tmp_replication_state s ON c.id = s.config_id
                          WHERE c.enabled = 1
                          AND (s.last_sync_at IS NULL OR datetime(s.last_sync_at, '+' || c.interval_seconds || ' seconds') <= datetime('now'))`,
                    params: [],
                })) as ReplicationConfig[]

                const results: SyncResult[] = []

                for (const config of configs) {
                    try {
                        const result = await this.syncConfig(config.id)
                        results.push(result)
                    } catch (error: any) {
                        console.error(
                            `Sync failed for config ${config.id}:`,
                            error
                        )
                        results.push({
                            configId: config.id,
                            rowsSynced: 0,
                            lastCursorValue: null,
                            syncedAt: new Date().toISOString(),
                            error: error?.message || 'Sync failed',
                        })
                    }
                }

                return createResponse(results, undefined, 200)
            } catch (error: any) {
                console.error(
                    'Unexpected error in replication callback:',
                    error
                )
                return createResponse(
                    undefined,
                    error?.message || 'Callback failed',
                    500
                )
            } finally {
                try {
                    await this.scheduleNextAlarm()
                } catch (alarmError) {
                    console.error(
                        'Failed to schedule next alarm, setting recovery:',
                        alarmError
                    )
                    try {
                        await this.dataSource?.rpc.setAlarm(Date.now() + 60000)
                    } catch (e) {
                        console.error('Failed to set recovery alarm:', e)
                    }
                }
            }
        })
    }
}
