import { StarbaseApp } from '../../src/handler'
import { StarbasePlugin } from '../../src/plugin'
import { DataSource } from '../../src/types'
import { createResponse } from '../../src/utils'
import { executeExternalQuery } from '../../src/operation'
import type { StarbaseDBConfiguration } from '../../src/handler'

const SQL_QUERIES = {
    CREATE_CONFIG_TABLE: `
        CREATE TABLE IF NOT EXISTS tmp_replication_config (
            table_name TEXT NOT NULL PRIMARY KEY,
            source_table TEXT NOT NULL,
            is_active INTEGER DEFAULT 1,
            last_replicated_at TEXT,
            interval_seconds INTEGER DEFAULT 3600,
            created_at TEXT DEFAULT (datetime('now'))
        )
    `,
    GET_ALL_CONFIGS: `
        SELECT table_name, source_table, is_active, last_replicated_at, interval_seconds
        FROM tmp_replication_config
    `,
    GET_ACTIVE_CONFIGS: `
        SELECT table_name, source_table, is_active, last_replicated_at, interval_seconds
        FROM tmp_replication_config
        WHERE is_active = 1
    `,
    UPSERT_CONFIG: `
        INSERT OR REPLACE INTO tmp_replication_config (table_name, source_table, is_active, interval_seconds)
        VALUES (?, ?, 1, ?)
    `,
    DELETE_CONFIG: `
        DELETE FROM tmp_replication_config WHERE table_name = ?
    `,
    UPDATE_LAST_REPLICATED: `
        UPDATE tmp_replication_config SET last_replicated_at = datetime('now') WHERE table_name = ?
    `,
}

export interface ReplicationConfig {
    /** The name of the table in the internal SQLite database */
    table_name: string
    /** The name of the source table in the external database (can include schema e.g. "public.users") */
    source_table: string
    /** Whether this replication config is active */
    is_active: number
    /** ISO timestamp of last successful replication */
    last_replicated_at: string | null
    /** Interval in seconds between replication runs */
    interval_seconds: number
}

export class DataReplicationPlugin extends StarbasePlugin {
    public pathPrefix: string = '/replication'
    private dataSource?: DataSource
    private _config?: StarbaseDBConfiguration

    constructor() {
        super('starbasedb:data-replication', {
            requiresAuth: true,
        })
    }

    override async register(app: StarbaseApp) {
        app.use(async (c, next) => {
            this.dataSource = c?.get('dataSource')
            this._config = c?.get('config')
            await this.init()
            await next()
        })

        // GET /replication - List all replication configs
        app.get(this.pathPrefix, async (c) => {
            if (!this.dataSource) {
                return createResponse(
                    undefined,
                    'Data source not available',
                    500
                )
            }

            const configs = await this.dataSource.rpc.executeQuery({
                sql: SQL_QUERIES.GET_ALL_CONFIGS,
                params: [],
            })

            return createResponse(configs, undefined, 200)
        })

        // POST /replication - Add or update a replication config
        app.post(this.pathPrefix, async (c) => {
            if (!this.dataSource) {
                return createResponse(
                    undefined,
                    'Data source not available',
                    500
                )
            }

            const body = (await c.req.json()) as {
                table_name: string
                source_table: string
                interval_seconds?: number
            }

            if (!body.table_name || !body.source_table) {
                return createResponse(
                    undefined,
                    'Both table_name and source_table are required',
                    400
                )
            }

            const intervalSeconds = body.interval_seconds ?? 3600

            await this.dataSource.rpc.executeQuery({
                sql: SQL_QUERIES.UPSERT_CONFIG,
                params: [body.table_name, body.source_table, intervalSeconds],
            })

            return createResponse(
                {
                    table_name: body.table_name,
                    source_table: body.source_table,
                    interval_seconds: intervalSeconds,
                },
                undefined,
                200
            )
        })

        // DELETE /replication/:tableName - Remove a replication config
        app.delete(`${this.pathPrefix}/:tableName`, async (c) => {
            if (!this.dataSource) {
                return createResponse(
                    undefined,
                    'Data source not available',
                    500
                )
            }

            const tableName = c.req.param('tableName')

            await this.dataSource.rpc.executeQuery({
                sql: SQL_QUERIES.DELETE_CONFIG,
                params: [tableName],
            })

            return createResponse({ success: true }, undefined, 200)
        })

        // POST /replication/sync - Trigger replication for all active configs
        app.post(`${this.pathPrefix}/sync`, async (c) => {
            if (!this.dataSource) {
                return createResponse(
                    undefined,
                    'Data source not available',
                    500
                )
            }

            if (!this.dataSource.external) {
                return createResponse(
                    undefined,
                    'No external data source configured. Replication requires an external database.',
                    400
                )
            }

            if (!this._config) {
                return createResponse(
                    undefined,
                    'Configuration not available',
                    500
                )
            }

            const results = await this.syncAll()
            return createResponse(results, undefined, 200)
        })

        // POST /replication/sync/:tableName - Trigger replication for a specific table
        app.post(`${this.pathPrefix}/sync/:tableName`, async (c) => {
            if (!this.dataSource) {
                return createResponse(
                    undefined,
                    'Data source not available',
                    500
                )
            }

            if (!this.dataSource.external) {
                return createResponse(
                    undefined,
                    'No external data source configured. Replication requires an external database.',
                    400
                )
            }

            if (!this._config) {
                return createResponse(
                    undefined,
                    'Configuration not available',
                    500
                )
            }

            const tableName = c.req.param('tableName')

            const configs = (await this.dataSource.rpc.executeQuery({
                sql: SQL_QUERIES.GET_ALL_CONFIGS,
                params: [],
            })) as ReplicationConfig[]

            const targetConfig = configs.find(
                (cfg) => cfg.table_name === tableName
            )

            if (!targetConfig) {
                return createResponse(
                    undefined,
                    `No replication config found for table: ${tableName}`,
                    404
                )
            }

            try {
                const result = await this.replicateTable(targetConfig)
                return createResponse(result, undefined, 200)
            } catch (error: any) {
                return createResponse(
                    undefined,
                    error?.message || 'Replication failed',
                    500
                )
            }
        })
    }

    private async init() {
        if (!this.dataSource) return

        await this.dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.CREATE_CONFIG_TABLE,
            params: [],
        })
    }

    /**
     * Sync all active replication configs that are due based on their interval.
     */
    public async syncAll(): Promise<
        { table: string; status: string; rows?: number; error?: string }[]
    > {
        if (!this.dataSource || !this._config) return []

        const configs = (await this.dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.GET_ACTIVE_CONFIGS,
            params: [],
        })) as ReplicationConfig[]

        const results: {
            table: string
            status: string
            rows?: number
            error?: string
        }[] = []

        for (const config of configs) {
            // Check if this table is due for replication based on interval
            if (config.last_replicated_at) {
                const lastReplicated = new Date(
                    config.last_replicated_at + 'Z'
                ).getTime()
                const now = Date.now()
                const intervalMs = config.interval_seconds * 1000

                if (now - lastReplicated < intervalMs) {
                    results.push({
                        table: config.table_name,
                        status: 'skipped',
                    })
                    continue
                }
            }

            try {
                const result = await this.replicateTable(config)
                results.push(result)
            } catch (error: any) {
                results.push({
                    table: config.table_name,
                    status: 'error',
                    error: error?.message || 'Unknown error',
                })
            }
        }

        return results
    }

    /**
     * Replicate a single table from the external source to internal SQLite.
     * Uses a full-table replacement strategy: drops and recreates the table.
     */
    private async replicateTable(
        config: ReplicationConfig
    ): Promise<{ table: string; status: string; rows: number }> {
        if (!this.dataSource || !this.dataSource.external || !this._config) {
            throw new Error('Data source or external connection not available')
        }

        // Step 1: Fetch all rows from the external source table
        const rows = (await executeExternalQuery({
            sql: `SELECT * FROM ${config.source_table}`,
            params: [],
            dataSource: this.dataSource,
            config: this._config,
        })) as Record<string, unknown>[]

        if (!rows || rows.length === 0) {
            // Even with 0 rows, update the last_replicated_at timestamp
            await this.dataSource.rpc.executeQuery({
                sql: SQL_QUERIES.UPDATE_LAST_REPLICATED,
                params: [config.table_name],
            })

            return { table: config.table_name, status: 'success', rows: 0 }
        }

        // Step 2: Infer columns from the first row
        const columns = Object.keys(rows[0])
        const columnDefs = columns.map((col) => `"${col}" TEXT`).join(', ')

        // Step 3: Drop existing table and recreate
        await this.dataSource.rpc.executeQuery({
            sql: `DROP TABLE IF EXISTS "${config.table_name}"`,
            params: [],
        })

        await this.dataSource.rpc.executeQuery({
            sql: `CREATE TABLE "${config.table_name}" (${columnDefs})`,
            params: [],
        })

        // Step 4: Insert rows in batches
        const BATCH_SIZE = 100
        let insertedCount = 0

        for (let i = 0; i < rows.length; i += BATCH_SIZE) {
            const batch = rows.slice(i, i + BATCH_SIZE)
            const placeholders = batch
                .map(() => `(${columns.map(() => '?').join(', ')})`)
                .join(', ')
            const values = batch.flatMap((row) =>
                columns.map((col) => {
                    const val = row[col]
                    if (val === null || val === undefined) return null
                    if (typeof val === 'object') return JSON.stringify(val)
                    return String(val)
                })
            )

            const quotedColumns = columns.map((col) => `"${col}"`).join(', ')

            await this.dataSource.rpc.executeQuery({
                sql: `INSERT INTO "${config.table_name}" (${quotedColumns}) VALUES ${placeholders}`,
                params: values,
            })

            insertedCount += batch.length
        }

        // Step 5: Update last replicated timestamp
        await this.dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.UPDATE_LAST_REPLICATED,
            params: [config.table_name],
        })

        return {
            table: config.table_name,
            status: 'success',
            rows: insertedCount,
        }
    }
}
