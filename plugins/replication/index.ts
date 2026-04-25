import { StarbaseApp, StarbaseDBConfiguration } from '../../src/handler'
import { StarbasePlugin } from '../../src/plugin'
import { DataSource, QueryResult } from '../../src/types'
import { createResponse } from '../../src/utils'
import { executeExternalQuery } from '../../src/operation'

// ----- SQL Queries for internal state management -----
const SQL_QUERIES = {
    CREATE_CONFIG_TABLE: `
        CREATE TABLE IF NOT EXISTS tmp_replication_config (
            source_table TEXT NOT NULL UNIQUE PRIMARY KEY,
            target_table TEXT NOT NULL,
            cursor_column TEXT NOT NULL DEFAULT 'id',
            interval_seconds INTEGER NOT NULL DEFAULT 60,
            is_active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
    `,
    CREATE_STATE_TABLE: `
        CREATE TABLE IF NOT EXISTS tmp_replication_state (
            source_table TEXT NOT NULL UNIQUE PRIMARY KEY,
            last_cursor_value TEXT,
            last_sync_at TEXT,
            rows_synced INTEGER NOT NULL DEFAULT 0,
            total_rows_synced INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            FOREIGN KEY (source_table) REFERENCES tmp_replication_config(source_table) ON DELETE CASCADE
        )
    `,
    INSERT_CONFIG: `
        INSERT OR REPLACE INTO tmp_replication_config (source_table, target_table, cursor_column, interval_seconds, is_active)
        VALUES (?, ?, ?, ?, 1)
    `,
    GET_ALL_CONFIG: `
        SELECT source_table, target_table, cursor_column, interval_seconds, is_active
        FROM tmp_replication_config
        WHERE is_active = 1
    `,
    DELETE_CONFIG: `
        DELETE FROM tmp_replication_config WHERE source_table = ?
    `,
    GET_STATE: `
        SELECT source_table, last_cursor_value, last_sync_at, rows_synced, total_rows_synced, last_error
        FROM tmp_replication_state
    `,
    UPSERT_STATE: `
        INSERT INTO tmp_replication_state (source_table, last_cursor_value, last_sync_at, rows_synced, total_rows_synced, last_error)
        VALUES (?, ?, datetime('now'), ?, ?, ?)
        ON CONFLICT(source_table) DO UPDATE SET
            last_cursor_value = excluded.last_cursor_value,
            last_sync_at = excluded.last_sync_at,
            rows_synced = excluded.rows_synced,
            total_rows_synced = tmp_replication_state.total_rows_synced + excluded.rows_synced,
            last_error = excluded.last_error
    `,
    GET_TABLE_STATE: `
        SELECT last_cursor_value FROM tmp_replication_state WHERE source_table = ?
    `,
}

// ----- Types -----
export interface ReplicationConfig {
    source_table: string
    target_table: string
    cursor_column: string
    interval_seconds: number
}

export interface ReplicationEventPayload {
    source_table: string
    target_table: string
    rows_synced: number
    cursor_value: string | null
    timestamp: string
}

export interface ReplicationStatus {
    source_table: string
    target_table: string
    cursor_column: string
    interval_seconds: number
    last_cursor_value: string | null
    last_sync_at: string | null
    rows_synced: number
    total_rows_synced: number
    last_error: string | null
}

// ----- Plugin Implementation -----
// Complexity: O(n) per sync cycle where n = number of new rows
export class ReplicationPlugin extends StarbasePlugin {
    public prefix: string = '/replication'
    private dataSource?: DataSource
    private config?: StarbaseDBConfiguration
    private eventCallbacks: ((payload: ReplicationEventPayload) => void)[] = []
    private initialized: boolean = false

    constructor() {
        super('starbasedb:replication', {
            requiresAuth: true,
        })
    }

    override async register(app: StarbaseApp) {
        // Middleware to capture dataSource and config on each request
        app.use(async (c, next) => {
            this.dataSource = c?.get('dataSource')
            this.config = c?.get('config')

            if (!this.initialized) {
                await this.initTables()
                this.initialized = true
            }

            await next()
        })

        // ---- REST API Routes ----

        // GET /replication/config — List all replication configurations
        app.get(`${this.prefix}/config`, async (c) => {
            if (this.config?.role !== 'admin') {
                return createResponse(undefined, 'Unauthorized', 401)
            }

            const configs = await this.getConfigs()
            return createResponse(configs, undefined, 200)
        })

        // POST /replication/config — Add or update a replication config
        app.post(`${this.prefix}/config`, async (c) => {
            if (this.config?.role !== 'admin') {
                return createResponse(undefined, 'Unauthorized', 401)
            }

            try {
                const body = (await c.req.json()) as ReplicationConfig

                if (!body.source_table || !body.target_table) {
                    return createResponse(
                        undefined,
                        'source_table and target_table are required',
                        400
                    )
                }

                await this.addConfig({
                    source_table: body.source_table,
                    target_table: body.target_table,
                    cursor_column: body.cursor_column || 'id',
                    interval_seconds: body.interval_seconds || 60,
                })

                return createResponse(
                    { success: true, message: `Replication configured for ${body.source_table}` },
                    undefined,
                    201
                )
            } catch (error: any) {
                return createResponse(
                    undefined,
                    error?.message || 'Failed to add replication config',
                    500
                )
            }
        })

        // DELETE /replication/config/:tableName — Remove a replication config
        app.delete(`${this.prefix}/config/:tableName`, async (c) => {
            if (this.config?.role !== 'admin') {
                return createResponse(undefined, 'Unauthorized', 401)
            }

            const tableName = c.req.param('tableName')

            if (!tableName) {
                return createResponse(undefined, 'Table name is required', 400)
            }

            await this.removeConfig(tableName)
            return createResponse(
                { success: true, message: `Replication removed for ${tableName}` },
                undefined,
                200
            )
        })

        // GET /replication/status — Get replication status for all tables
        app.get(`${this.prefix}/status`, async (c) => {
            if (this.config?.role !== 'admin') {
                return createResponse(undefined, 'Unauthorized', 401)
            }

            const status = await this.getStatus()
            return createResponse(status, undefined, 200)
        })

        // POST /replication/sync — Trigger an immediate sync for all configured tables
        app.post(`${this.prefix}/sync`, async (c) => {
            if (this.config?.role !== 'admin') {
                return createResponse(undefined, 'Unauthorized', 401)
            }

            try {
                const results = await this.syncAll()
                return createResponse(results, undefined, 200)
            } catch (error: any) {
                return createResponse(
                    undefined,
                    error?.message || 'Sync failed',
                    500
                )
            }
        })

        // POST /replication/sync/:tableName — Trigger sync for a specific table
        app.post(`${this.prefix}/sync/:tableName`, async (c) => {
            if (this.config?.role !== 'admin') {
                return createResponse(undefined, 'Unauthorized', 401)
            }

            const tableName = c.req.param('tableName')

            if (!tableName) {
                return createResponse(undefined, 'Table name is required', 400)
            }

            try {
                const result = await this.syncTable(tableName)
                return createResponse(result, undefined, 200)
            } catch (error: any) {
                return createResponse(
                    undefined,
                    error?.message || `Sync failed for ${tableName}`,
                    500
                )
            }
        })
    }

    // ----- Internal Methods -----

    // Complexity: O(1) — DDL operations
    private async initTables() {
        if (!this.dataSource) return

        await this.dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.CREATE_CONFIG_TABLE,
            params: [],
        })

        await this.dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.CREATE_STATE_TABLE,
            params: [],
        })
    }

    // Complexity: O(1) — single INSERT
    private async addConfig(config: ReplicationConfig) {
        if (!this.dataSource) throw new Error('ReplicationPlugin not initialized')

        await this.dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.INSERT_CONFIG,
            params: [
                config.source_table,
                config.target_table,
                config.cursor_column,
                config.interval_seconds,
            ],
        })
    }

    // Complexity: O(1) — single DELETE
    private async removeConfig(sourceTable: string) {
        if (!this.dataSource) throw new Error('ReplicationPlugin not initialized')

        await this.dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.DELETE_CONFIG,
            params: [sourceTable],
        })
    }

    // Complexity: O(k) — where k = number of configured tables
    private async getConfigs(): Promise<ReplicationConfig[]> {
        if (!this.dataSource) return []

        const result = (await this.dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.GET_ALL_CONFIG,
            params: [],
        })) as QueryResult[]

        return result as unknown as ReplicationConfig[]
    }

    // Complexity: O(k) — where k = number of configured tables
    private async getStatus(): Promise<ReplicationStatus[]> {
        if (!this.dataSource) return []

        const configs = await this.getConfigs()
        const states = (await this.dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.GET_STATE,
            params: [],
        })) as QueryResult[]

        const stateMap = new Map<string, any>()
        for (const state of states) {
            stateMap.set(state.source_table as string, state)
        }

        return configs.map((config) => {
            const state = stateMap.get(config.source_table)
            return {
                source_table: config.source_table,
                target_table: config.target_table,
                cursor_column: config.cursor_column,
                interval_seconds: config.interval_seconds,
                last_cursor_value: state?.last_cursor_value ?? null,
                last_sync_at: state?.last_sync_at ?? null,
                rows_synced: state?.rows_synced ?? 0,
                total_rows_synced: state?.total_rows_synced ?? 0,
                last_error: state?.last_error ?? null,
            }
        })
    }

    // Complexity: O(k * n) — k tables, n rows each
    public async syncAll(): Promise<ReplicationEventPayload[]> {
        const configs = await this.getConfigs()
        const results: ReplicationEventPayload[] = []

        for (const config of configs) {
            try {
                const result = await this.syncTable(config.source_table)
                results.push(result)
            } catch (error: any) {
                console.error(`Replication error for ${config.source_table}:`, error)
                // Record the error in state but continue with other tables
                await this.updateState(config.source_table, null, 0, error?.message)
                results.push({
                    source_table: config.source_table,
                    target_table: config.target_table,
                    rows_synced: 0,
                    cursor_value: null,
                    timestamp: new Date().toISOString(),
                })
            }
        }

        return results
    }

    // Complexity: O(n) — where n = number of new rows fetched
    public async syncTable(sourceTable: string): Promise<ReplicationEventPayload> {
        if (!this.dataSource) throw new Error('ReplicationPlugin not initialized')
        if (!this.dataSource.external) throw new Error('No external data source configured')

        // Get config for this table
        const configs = await this.getConfigs()
        const config = configs.find((c) => c.source_table === sourceTable)

        if (!config) {
            throw new Error(`No replication config found for table: ${sourceTable}`)
        }

        // Get last cursor value
        const stateResult = (await this.dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.GET_TABLE_STATE,
            params: [sourceTable],
        })) as QueryResult[]

        const lastCursorValue = stateResult?.[0]?.last_cursor_value as string | null

        // Build the external query with cursor-based pagination
        let fetchSQL: string
        let fetchParams: any[]

        if (lastCursorValue !== null && lastCursorValue !== undefined) {
            fetchSQL = `SELECT * FROM ${this.escapeIdentifier(config.source_table)} WHERE ${this.escapeIdentifier(config.cursor_column)} > ? ORDER BY ${this.escapeIdentifier(config.cursor_column)} ASC LIMIT 1000`
            fetchParams = [lastCursorValue]
        } else {
            fetchSQL = `SELECT * FROM ${this.escapeIdentifier(config.source_table)} ORDER BY ${this.escapeIdentifier(config.cursor_column)} ASC LIMIT 1000`
            fetchParams = []
        }

        // Fetch rows from external source
        const rows = await executeExternalQuery({
            sql: fetchSQL,
            params: fetchParams,
            dataSource: this.dataSource,
            config: this.config!,
        })

        const fetchedRows = Array.isArray(rows) ? rows : []
        let newCursorValue = lastCursorValue

        if (fetchedRows.length > 0) {
            // Ensure the target table exists in internal SQLite
            await this.ensureTargetTable(config.target_table, fetchedRows[0])

            // Insert rows into internal SQLite using INSERT OR REPLACE
            for (const row of fetchedRows) {
                const columns = Object.keys(row)
                const placeholders = columns.map(() => '?').join(', ')
                const values = columns.map((col) => row[col])

                const insertSQL = `INSERT OR REPLACE INTO ${this.escapeIdentifier(config.target_table)} (${columns.map((c) => this.escapeIdentifier(c)).join(', ')}) VALUES (${placeholders})`

                await this.dataSource.rpc.executeQuery({
                    sql: insertSQL,
                    params: values,
                })
            }

            // Update cursor to the last row's cursor column value
            const lastRow = fetchedRows[fetchedRows.length - 1]
            newCursorValue = String(lastRow[config.cursor_column])
        }

        // Update replication state
        await this.updateState(
            config.source_table,
            newCursorValue,
            fetchedRows.length,
            null
        )

        const payload: ReplicationEventPayload = {
            source_table: config.source_table,
            target_table: config.target_table,
            rows_synced: fetchedRows.length,
            cursor_value: newCursorValue,
            timestamp: new Date().toISOString(),
        }

        // Trigger event callbacks
        this.eventCallbacks.forEach((callback) => {
            try {
                callback(payload)
            } catch (error) {
                console.error('Error in replication event callback:', error)
            }
        })

        return payload
    }

    /**
     * Ensures the target table exists in the internal SQLite database.
     * Creates the table based on the column structure of the first row.
     * Complexity: O(c) where c = number of columns
     */
    private async ensureTargetTable(
        targetTable: string,
        sampleRow: Record<string, any>
    ) {
        if (!this.dataSource) return

        const columns = Object.keys(sampleRow)
        const columnDefs = columns
            .map((col) => {
                const value = sampleRow[col]
                let sqlType = 'TEXT'

                if (typeof value === 'number') {
                    sqlType = Number.isInteger(value) ? 'INTEGER' : 'REAL'
                } else if (typeof value === 'boolean') {
                    sqlType = 'INTEGER'
                }

                return `${this.escapeIdentifier(col)} ${sqlType}`
            })
            .join(', ')

        const createSQL = `CREATE TABLE IF NOT EXISTS ${this.escapeIdentifier(targetTable)} (${columnDefs})`

        await this.dataSource.rpc.executeQuery({
            sql: createSQL,
            params: [],
        })
    }

    /**
     * Updates the replication state for a given source table.
     * Complexity: O(1) — single UPSERT
     */
    private async updateState(
        sourceTable: string,
        cursorValue: string | null,
        rowsSynced: number,
        error: string | null
    ) {
        if (!this.dataSource) return

        await this.dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.UPSERT_STATE,
            params: [sourceTable, cursorValue, rowsSynced, rowsSynced, error],
        })
    }

    /**
     * Escape a SQL identifier to prevent injection.
     * Complexity: O(1)
     */
    private escapeIdentifier(identifier: string): string {
        // Remove any existing quotes and wrap in double quotes
        return `"${identifier.replace(/"/g, '""')}"`
    }

    /**
     * Register a callback to be invoked after each replication sync event.
     * @param callback The function to call with the replication event payload
     * @param ctx Optional ExecutionContext for non-blocking execution via waitUntil
     */
    public onEvent(
        callback: (payload: ReplicationEventPayload) => void | Promise<void>,
        ctx?: ExecutionContext
    ) {
        const wrappedCallback = async (payload: ReplicationEventPayload) => {
            const result = callback(payload)
            if (result instanceof Promise && ctx) {
                ctx.waitUntil(result)
            }
        }
        this.eventCallbacks.push(wrappedCallback)
    }
}
