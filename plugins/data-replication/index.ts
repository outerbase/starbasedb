import { StarbaseApp, StarbaseDBConfiguration } from '../../src/handler'
import { StarbasePlugin } from '../../src/plugin'
import {
    DataSource,
    QueryResult,
    ExternalDatabaseSource,
} from '../../src/types'
import { createResponse } from '../../src/utils'
import { executeSDKQuery } from '../../src/operation'

const SQL_QUERIES = {
    CREATE_REPLICATION_CONFIG_TABLE: `
        CREATE TABLE IF NOT EXISTS tmp_replication_configs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            source_config TEXT NOT NULL,
            target_table TEXT NOT NULL,
            source_table TEXT NOT NULL,
            sync_interval_minutes INTEGER DEFAULT 60,
            tracking_column TEXT DEFAULT 'id',
            last_sync_value TEXT,
            last_sync_timestamp DATETIME,
            is_active INTEGER DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `,
    CREATE_REPLICATION_LOGS_TABLE: `
        CREATE TABLE IF NOT EXISTS tmp_replication_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            config_name TEXT NOT NULL,
            status TEXT NOT NULL,
            records_processed INTEGER DEFAULT 0,
            error_message TEXT,
            sync_duration_ms INTEGER,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `,
    INSERT_CONFIG: `
        INSERT OR REPLACE INTO tmp_replication_configs 
        (name, source_config, target_table, source_table, sync_interval_minutes, tracking_column, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    GET_ACTIVE_CONFIGS: `
        SELECT * FROM tmp_replication_configs WHERE is_active = 1
    `,
    GET_CONFIG_BY_NAME: `
        SELECT * FROM tmp_replication_configs WHERE name = ?
    `,
    UPDATE_LAST_SYNC: `
        UPDATE tmp_replication_configs 
        SET last_sync_value = ?, last_sync_timestamp = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE name = ?
    `,
    DELETE_CONFIG: `
        DELETE FROM tmp_replication_configs WHERE name = ?
    `,
    INSERT_LOG: `
        INSERT INTO tmp_replication_logs (config_name, status, records_processed, error_message, sync_duration_ms)
        VALUES (?, ?, ?, ?, ?)
    `,
    GET_LOGS: `
        SELECT * FROM tmp_replication_logs ORDER BY created_at DESC LIMIT ?
    `,
}

export interface ReplicationConfig {
    id?: number
    name: string
    source_config: string // JSON string of external database config
    target_table: string
    source_table: string
    sync_interval_minutes: number
    tracking_column: string
    last_sync_value?: string
    last_sync_timestamp?: string
    is_active: number
    created_at?: string
    updated_at?: string
}

export interface ReplicationEventPayload {
    config_name: string
    status: 'success' | 'error'
    records_processed: number
    error_message?: string
    sync_duration_ms: number
}

export class DataReplicationPlugin extends StarbasePlugin {
    public pathPrefix: string = '/data-replication'
    private dataSource?: DataSource
    private config?: StarbaseDBConfiguration
    private eventCallbacks: ((payload: ReplicationEventPayload) => void)[] = []
    private replicationTimers: Map<string, any> = new Map()

    constructor() {
        super('starbasedb:data-replication', {
            requiresAuth: true,
        })
    }

    override async register(app: StarbaseApp) {
        app.use(async (c, next) => {
            this.dataSource = c?.get('dataSource')
            this.config = c?.get('config')
            await this.init()
            await next()
        })

        // Configure replication
        app.post(`${this.pathPrefix}/configure`, async (c) => {
            try {
                const body = (await c.req.json()) as {
                    name: string
                    sourceConfig: ExternalDatabaseSource
                    targetTable: string
                    sourceTable: string
                    syncIntervalMinutes?: number
                    trackingColumn?: string
                    isActive?: boolean
                }

                if (
                    !body.name ||
                    !body.sourceConfig ||
                    !body.targetTable ||
                    !body.sourceTable
                ) {
                    return createResponse(
                        null,
                        'Missing required fields: name, sourceConfig, targetTable, sourceTable',
                        400
                    )
                }

                await this.dataSource?.rpc.executeQuery({
                    sql: SQL_QUERIES.INSERT_CONFIG,
                    params: [
                        body.name,
                        JSON.stringify(body.sourceConfig),
                        body.targetTable,
                        body.sourceTable,
                        body.syncIntervalMinutes || 60,
                        body.trackingColumn || 'id',
                        body.isActive !== false ? 1 : 0,
                    ],
                })

                // Start replication if active
                if (body.isActive !== false) {
                    await this.startReplication(body.name)
                }

                return createResponse(
                    {
                        success: true,
                        message: 'Replication configured successfully',
                    },
                    undefined,
                    200
                )
            } catch (error) {
                console.error('Error configuring replication:', error)
                return createResponse(
                    null,
                    `Error configuring replication: ${error}`,
                    500
                )
            }
        })

        // Start replication for a specific config
        app.post(`${this.pathPrefix}/start/:name`, async (c) => {
            try {
                const name = c.req.param('name')
                await this.startReplication(name)
                return createResponse(
                    {
                        success: true,
                        message: `Replication started for ${name}`,
                    },
                    undefined,
                    200
                )
            } catch (error) {
                console.error('Error starting replication:', error)
                return createResponse(
                    null,
                    `Error starting replication: ${error}`,
                    500
                )
            }
        })

        // Stop replication for a specific config
        app.post(`${this.pathPrefix}/stop/:name`, async (c) => {
            try {
                const name = c.req.param('name')
                await this.stopReplication(name)
                return createResponse(
                    {
                        success: true,
                        message: `Replication stopped for ${name}`,
                    },
                    undefined,
                    200
                )
            } catch (error) {
                console.error('Error stopping replication:', error)
                return createResponse(
                    null,
                    `Error stopping replication: ${error}`,
                    500
                )
            }
        })

        // Trigger immediate sync
        app.post(`${this.pathPrefix}/sync/:name`, async (c) => {
            try {
                const name = c.req.param('name')
                await this.performSync(name)
                return createResponse(
                    { success: true, message: `Sync completed for ${name}` },
                    undefined,
                    200
                )
            } catch (error) {
                console.error('Error performing sync:', error)
                return createResponse(
                    null,
                    `Error performing sync: ${error}`,
                    500
                )
            }
        })

        // Get replication status
        app.get(`${this.pathPrefix}/status`, async (c) => {
            try {
                const configQueryResult =
                    await this.dataSource?.rpc.executeQuery({
                        sql: SQL_QUERIES.GET_ACTIVE_CONFIGS,
                        params: [],
                    })
                const configs = Array.isArray(configQueryResult)
                    ? (configQueryResult as ReplicationConfig[])
                    : []

                const status = configs.map((config) => ({
                    ...config,
                    source_config: JSON.parse(config.source_config),
                    is_running: this.replicationTimers.has(config.name),
                }))

                return createResponse({ configs: status }, undefined, 200)
            } catch (error) {
                console.error('Error getting replication status:', error)
                return createResponse(
                    null,
                    `Error getting status: ${error}`,
                    500
                )
            }
        })

        // Get replication logs
        app.get(`${this.pathPrefix}/logs`, async (c) => {
            try {
                const limit = parseInt(c.req.query('limit') || '50')
                const logs = await this.dataSource?.rpc.executeQuery({
                    sql: SQL_QUERIES.GET_LOGS,
                    params: [limit],
                })

                return createResponse({ logs }, undefined, 200)
            } catch (error) {
                console.error('Error getting replication logs:', error)
                return createResponse(null, `Error getting logs: ${error}`, 500)
            }
        })

        // Delete replication config
        app.delete(`${this.pathPrefix}/configure/:name`, async (c) => {
            try {
                const name = c.req.param('name')
                await this.stopReplication(name)

                await this.dataSource?.rpc.executeQuery({
                    sql: SQL_QUERIES.DELETE_CONFIG,
                    params: [name],
                })

                return createResponse(
                    {
                        success: true,
                        message: `Replication config deleted for ${name}`,
                    },
                    undefined,
                    200
                )
            } catch (error) {
                console.error('Error deleting replication config:', error)
                return createResponse(
                    null,
                    `Error deleting config: ${error}`,
                    500
                )
            }
        })
    }

    private async init() {
        if (!this.dataSource) return

        // Create replication tables
        await this.dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.CREATE_REPLICATION_CONFIG_TABLE,
            params: [],
        })

        await this.dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.CREATE_REPLICATION_LOGS_TABLE,
            params: [],
        })

        // Start all active replications
        await this.startAllActiveReplications()
    }

    private async startAllActiveReplications() {
        try {
            const configResult = await this.dataSource?.rpc.executeQuery({
                sql: SQL_QUERIES.GET_ACTIVE_CONFIGS,
                params: [],
            })
            const configs = Array.isArray(configResult)
                ? (configResult as ReplicationConfig[])
                : []

            for (const config of configs) {
                await this.startReplication(config.name)
            }
        } catch (error) {
            console.error('Error starting active replications:', error)
        }
    }

    private async startReplication(name: string) {
        // Stop existing timer if any
        await this.stopReplication(name)

        const configQueryResult = await this.dataSource?.rpc.executeQuery({
            sql: SQL_QUERIES.GET_CONFIG_BY_NAME,
            params: [name],
        })
        const configResult = Array.isArray(configQueryResult)
            ? (configQueryResult as ReplicationConfig[])
            : []

        if (!configResult || configResult.length === 0) {
            throw new Error(`Replication config not found: ${name}`)
        }

        const config = configResult[0]
        const intervalMs = config.sync_interval_minutes * 60 * 1000

        // Set up periodic sync
        const timer = setInterval(async () => {
            await this.performSync(name)
        }, intervalMs)

        this.replicationTimers.set(name, timer)

        // Perform initial sync
        await this.performSync(name)
    }

    private async stopReplication(name: string) {
        const timer = this.replicationTimers.get(name)
        if (timer) {
            clearInterval(timer)
            this.replicationTimers.delete(name)
        }
    }

    private async performSync(name: string) {
        const startTime = Date.now()
        let recordsProcessed = 0
        let errorMessage: string | undefined

        try {
            const configQueryResult = await this.dataSource?.rpc.executeQuery({
                sql: SQL_QUERIES.GET_CONFIG_BY_NAME,
                params: [name],
            })
            const configResult = Array.isArray(configQueryResult)
                ? (configQueryResult as ReplicationConfig[])
                : []

            if (!configResult || configResult.length === 0) {
                throw new Error(`Replication config not found: ${name}`)
            }

            const config = configResult[0]
            const externalConfig = JSON.parse(
                config.source_config
            ) as ExternalDatabaseSource

            // Build incremental query
            let query = `SELECT * FROM ${config.source_table}`
            const params: any[] = []

            if (config.last_sync_value) {
                query += ` WHERE ${config.tracking_column} > ?`
                params.push(config.last_sync_value)
            }

            query += ` ORDER BY ${config.tracking_column}`

            // Here you would implement the actual external database connection
            // For now, we'll simulate this functionality
            console.log(`Performing sync for ${name}: ${query}`, params)

            // Simulate external data fetch
            const externalData = await this.fetchExternalData(
                externalConfig,
                query,
                params
            )

            if (externalData && externalData.length > 0) {
                // Insert data into target table
                await this.insertDataToTarget(config.target_table, externalData)
                recordsProcessed = externalData.length

                // Update last sync value
                const lastValue =
                    externalData[externalData.length - 1][
                        config.tracking_column
                    ]
                await this.dataSource?.rpc.executeQuery({
                    sql: SQL_QUERIES.UPDATE_LAST_SYNC,
                    params: [lastValue, name],
                })
            }

            // Log success
            await this.logSync(
                name,
                'success',
                recordsProcessed,
                undefined,
                Date.now() - startTime
            )

            // Trigger event callbacks
            this.triggerEventCallbacks({
                config_name: name,
                status: 'success',
                records_processed: recordsProcessed,
                sync_duration_ms: Date.now() - startTime,
            })
        } catch (error) {
            errorMessage =
                error instanceof Error ? error.message : String(error)
            console.error(`Sync error for ${name}:`, error)

            // Log error
            await this.logSync(
                name,
                'error',
                recordsProcessed,
                errorMessage,
                Date.now() - startTime
            )

            // Trigger event callbacks
            this.triggerEventCallbacks({
                config_name: name,
                status: 'error',
                records_processed: recordsProcessed,
                error_message: errorMessage,
                sync_duration_ms: Date.now() - startTime,
            })
        }
    }

    private async fetchExternalData(
        config: ExternalDatabaseSource,
        query: string,
        params: any[]
    ): Promise<any[]> {
        try {
            // Create a temporary DataSource for external connection
            const externalDataSource: DataSource = {
                rpc: this.dataSource!.rpc, // Not used for external queries
                source: 'external',
                external: config,
                executionContext: this.dataSource?.executionContext,
            }

            console.log('Fetching external data from:', {
                dialect: config.dialect,
                host: 'host' in config ? config.host : 'N/A',
                database: 'database' in config ? config.database : 'N/A',
            })
            console.log('Query:', query)
            console.log('Params:', params)

            // Use the existing SDK query execution from StarbaseDB
            const result = await executeSDKQuery({
                sql: query,
                params,
                dataSource: externalDataSource,
                config: this.config!,
            })

            console.log(
                `Fetched ${Array.isArray(result) ? result.length : 0} records from external database`
            )
            return Array.isArray(result) ? result : []
        } catch (error) {
            console.error('Error fetching external data:', error)
            throw new Error(
                `Failed to fetch external data: ${error instanceof Error ? error.message : String(error)}`
            )
        }
    }

    private async insertDataToTarget(targetTable: string, data: any[]) {
        if (!data || data.length === 0) return

        // Get column names from first row
        const columns = Object.keys(data[0])
        const placeholders = columns.map(() => '?').join(', ')

        const insertQuery = `INSERT OR REPLACE INTO ${targetTable} (${columns.join(', ')}) VALUES (${placeholders})`

        // Insert each row
        for (const row of data) {
            const values = columns.map((col) => row[col])
            await this.dataSource?.rpc.executeQuery({
                sql: insertQuery,
                params: values,
            })
        }
    }

    private async logSync(
        configName: string,
        status: string,
        recordsProcessed: number,
        errorMessage?: string,
        syncDurationMs?: number
    ) {
        await this.dataSource?.rpc.executeQuery({
            sql: SQL_QUERIES.INSERT_LOG,
            params: [
                configName,
                status,
                recordsProcessed,
                errorMessage,
                syncDurationMs,
            ],
        })
    }

    private triggerEventCallbacks(payload: ReplicationEventPayload) {
        this.eventCallbacks.forEach((callback) => {
            try {
                callback(payload)
            } catch (error) {
                console.error('Error in replication event callback:', error)
            }
        })
    }

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
