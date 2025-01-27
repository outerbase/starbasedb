import {
    StarbaseApp,
    StarbaseContext,
    StarbaseDBConfiguration,
} from '../../src/handler'
import { StarbasePlugin } from '../../src/plugin'
import { DataSource } from '../../src/types'

export interface TableSyncConfig {
    name: string
    schema?: string // Optional schema name (for databases that support schemas)
    timestamp_column?: string // Column to use for timestamp-based syncing (default: 'created_at')
    id_column?: string // Column to use for id-based syncing (default: 'id')
    batch_size?: number // Number of records to sync at once (default: 1000)
}

export interface SyncConfig {
    sync_interval: number
    tables: (string | TableSyncConfig)[] // Can specify just table name or detailed config
}

export interface TableMetadata {
    lastSyncTimestamp: number
    lastSyncId?: string | number
    sync_errors?: string
}

export interface QueryResult {
    rows: any[][]
    columns: string[]
}

export interface ColumnDefinition {
    name: string
    type: string
    nullable?: boolean
    defaultValue?: string
}

export interface SyncSourceConfig {
    dialect: string
    [key: string]: any
}

// Abstract base class for database-specific sync implementations
export abstract class DatabaseSyncSource {
    protected dataSource?: DataSource
    protected config: SyncSourceConfig

    constructor(config: SyncSourceConfig) {
        this.config = config
    }

    abstract get dialect(): string

    async setDataSource(dataSource: DataSource): Promise<void> {
        this.dataSource = dataSource
        console.log(`${this.dialect}SyncSource: DataSource set`, {
            hasDataSource: !!this.dataSource,
            hasExternal: !!this.dataSource?.external,
            dialect: this.dataSource?.external?.dialect,
        })
    }

    protected getExternalDataSource(): DataSource | undefined {
        if (!this.dataSource?.external) {
            console.error(
                `${this.dialect}SyncSource: getExternalDataSource failed`,
                {
                    hasDataSource: !!this.dataSource,
                    hasExternal: !!this.dataSource?.external,
                    dialect: this.dataSource?.external?.dialect,
                }
            )
            return undefined
        }
        return this.dataSource
    }

    abstract validateConnection(): Promise<boolean>
    abstract getTableSchema(tableName: string): Promise<ColumnDefinition[]>
    abstract getIncrementalData(
        tableName: string,
        lastSync: TableMetadata,
        tableConfig: TableSyncConfig
    ): Promise<QueryResult>
    abstract mapDataType(sourceType: string): string
    abstract validateTableStructure(
        tableName: string,
        tableConfig: TableSyncConfig
    ): Promise<{ valid: boolean; errors: string[] }>
}

export class DataSyncPlugin extends StarbasePlugin {
    private config: SyncConfig
    private syncInterval: number
    private syncTimeouts: Map<string, ReturnType<typeof setTimeout>> = new Map()
    private tableMetadata: Map<string, TableMetadata> = new Map()
    private dataSource?: DataSource
    private syncSource: DatabaseSyncSource
    private tableConfigs: Map<string, TableSyncConfig> = new Map()
    private schemaTableMap: Map<string, string> = new Map() // Maps schema.table to SQLite table name

    constructor(
        syncSource: DatabaseSyncSource,
        opts?: { sync_interval?: number; tables?: (string | TableSyncConfig)[] }
    ) {
        super('starbasedb:data-sync', {
            requiresAuth: true,
        })

        this.syncSource = syncSource
        this.config = {
            sync_interval: opts?.sync_interval || 300,
            tables: opts?.tables || [],
        }
        this.syncInterval = this.config.sync_interval * 1000

        // Process table configurations
        this.config.tables.forEach((tableConfig) => {
            const config: TableSyncConfig =
                typeof tableConfig === 'string'
                    ? {
                          name: this.parseTableName(tableConfig).table,
                          schema: this.parseTableName(tableConfig).schema,
                          timestamp_column: 'created_at',
                          id_column: 'id',
                          batch_size: 1000,
                      }
                    : {
                          ...tableConfig,
                          name: this.parseTableName(tableConfig.name).table,
                          schema:
                              tableConfig.schema ||
                              this.parseTableName(tableConfig.name).schema,
                          timestamp_column:
                              tableConfig.timestamp_column || 'created_at',
                          id_column: tableConfig.id_column || 'id',
                          batch_size: tableConfig.batch_size || 1000,
                      }

            // Store the mapping between schema.table and SQLite table name
            const sqliteTableName = this.getSQLiteTableName(config)
            this.schemaTableMap.set(
                this.getFullTableName(config),
                sqliteTableName
            )
            this.tableConfigs.set(sqliteTableName, config)
        })
    }

    // Parse a table name that might include a schema
    private parseTableName(fullName: string): {
        schema?: string
        table: string
    } {
        const parts = fullName.split('.')
        if (parts.length === 2) {
            return { schema: parts[0], table: parts[1] }
        }
        return { table: fullName }
    }

    // Get the full table name including schema if present
    private getFullTableName(config: TableSyncConfig): string {
        return config.schema ? `${config.schema}.${config.name}` : config.name
    }

    // Get the SQLite table name based on configuration
    private getSQLiteTableName(config: TableSyncConfig): string {
        // For public schema, just use the table name with tmp_ prefix
        if (!config.schema || config.schema === 'public') {
            return `tmp_${config.name}`
        }
        // For other schemas, use tmp_schema_table format to avoid conflicts
        return `tmp_${config.schema}_${config.name}`
    }

    // Transform a query that might use schema.table notation to use the correct SQLite table name
    private transformQuery(sql: string): string {
        let transformedSql = sql

        // Replace all schema.table occurrences with their SQLite table names
        for (const [fullName, sqliteName] of this.schemaTableMap.entries()) {
            // Escape special characters in the table name for regex
            const escapedName = fullName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            // Use word boundaries to avoid partial matches
            const regex = new RegExp(`\\b${escapedName}\\b`, 'g')
            transformedSql = transformedSql.replace(regex, sqliteName)
        }

        return transformedSql
    }

    public getConfig(): SyncConfig {
        const tables = Array.from(this.tableConfigs.values())
        return {
            sync_interval: this.config.sync_interval,
            tables,
        }
    }

    override async register(app: StarbaseApp): Promise<void> {
        app.use(async (c: StarbaseContext, next: () => Promise<void>) => {
            this.dataSource = c?.get('dataSource')

            if (this.dataSource) {
                await this.syncSource.setDataSource(this.dataSource)
                c.set('dataSource', this.dataSource)
            }

            await next()
        })

        // Validate connection to source database
        const isValid = await this.syncSource.validateConnection()
        if (!isValid) {
            console.error(
                `Database sync plugin: ${this.syncSource.dialect} connection not available or invalid`
            )
            return
        }

        // Create metadata table if it doesn't exist
        await this.dataSource?.rpc.executeQuery({
            sql: `
          CREATE TABLE IF NOT EXISTS tmp_data_sync_metadata (
            table_name TEXT PRIMARY KEY,
            last_sync_timestamp INTEGER,
            last_sync_id TEXT,
            sync_errors TEXT
          )
        `,
            params: [],
        })

        await this.loadMetadata()

        // Validate table structures before starting sync
        const validationResults = await Promise.all(
            Array.from(this.tableConfigs.entries()).map(
                async ([tableName, config]) => {
                    const result = await this.syncSource.validateTableStructure(
                        tableName,
                        config
                    )
                    if (!result.valid) {
                        console.error(
                            `Table validation failed for '${tableName}':`,
                            result.errors
                        )
                    }
                    return { tableName, ...result }
                }
            )
        )

        const validTables = validationResults
            .filter((result) => result.valid)
            .map((result) => result.tableName)

        if (validTables.length === 0) {
            console.error('No valid tables to sync')
            return
        }

        for (const tableName of validTables) {
            await this.scheduleSyncForTable(tableName)
        }
    }

    private async loadMetadata(): Promise<void> {
        if (!this.dataSource) return

        const result = (await this.dataSource.rpc.executeQuery({
            sql: 'SELECT table_name, last_sync_timestamp, last_sync_id FROM tmp_data_sync_metadata',
            params: [],
        })) as QueryResult

        const rows = result.rows.map((row) => ({
            table_name: row[0] as string,
            last_sync_timestamp: row[1] as number,
            last_sync_id: row[2] as string,
        }))

        for (const row of rows) {
            this.tableMetadata.set(row.table_name, {
                lastSyncTimestamp: row.last_sync_timestamp,
                lastSyncId: row.last_sync_id,
            })
        }
    }

    private async updateMetadata(
        table: string,
        metadata: TableMetadata
    ): Promise<void> {
        if (!this.dataSource) return

        await this.dataSource.rpc.executeQuery({
            sql: `INSERT OR REPLACE INTO tmp_data_sync_metadata (table_name, last_sync_timestamp, last_sync_id)
            VALUES (?, ?, ?)`,
            params: [
                table,
                metadata.lastSyncTimestamp,
                metadata.lastSyncId?.toString(),
            ],
        })
        this.tableMetadata.set(table, metadata)
    }

    private async scheduleSyncForTable(tableName: string): Promise<void> {
        const sync = async () => {
            try {
                await this.syncTable(tableName)
            } catch (error) {
                console.error(`Error syncing table ${tableName}:`, error)
            }

            // Schedule next sync
            const timeoutId = setTimeout(() => sync(), this.syncInterval)
            this.syncTimeouts.set(tableName, timeoutId)
        }

        await sync()
    }

    public async syncTable(tableName: string): Promise<void> {
        if (!this.dataSource) return

        try {
            const metadata = this.tableMetadata.get(tableName) || {
                lastSyncTimestamp: 0,
                lastSyncId: undefined,
            }

            const tableConfig = this.tableConfigs.get(tableName)
            if (!tableConfig) {
                throw new Error(
                    `No configuration found for table '${tableName}'`
                )
            }

            console.log(`Starting sync for table ${tableName}`, {
                config: tableConfig,
                lastSync: metadata,
            })

            // Validate table structure before sync
            const validation = await this.syncSource.validateTableStructure(
                tableName,
                tableConfig
            )
            if (!validation.valid) {
                throw new Error(
                    `Table validation failed: ${validation.errors.join(', ')}`
                )
            }

            // Get table structure using the sync plugin
            const columns = await this.syncSource.getTableSchema(tableName)
            console.log(`Retrieved schema for table ${tableName}`, { columns })

            // Create table in internal database if it doesn't exist
            const createTableSQL = this.generateCreateTableSQL(
                tableName,
                columns
            )
            await this.dataSource.rpc.executeQuery({
                sql: createTableSQL,
                params: [],
            })

            // Fetch new records using the sync plugin with table config
            const result = await this.syncSource.getIncrementalData(
                tableName,
                metadata,
                tableConfig
            )
            console.log(
                `Retrieved ${result.rows.length} new records for table ${tableName}`
            )

            if (result.rows.length > 0) {
                let syncedCount = 0
                // Insert new records into internal database
                for (const row of result.rows) {
                    try {
                        const record = row.reduce(
                            (
                                obj: Record<string, any>,
                                val: any,
                                idx: number
                            ) => {
                                obj[result.columns[idx]] = val
                                return obj
                            },
                            {}
                        )

                        const columns = Object.keys(record)
                        const values = Object.values(record)
                        const placeholders = Array(values.length)
                            .fill('?')
                            .join(',')

                        await this.dataSource.rpc.executeQuery({
                            sql: `INSERT OR REPLACE INTO ${tableName} (${columns.join(',')}) VALUES (${placeholders})`,
                            params: values,
                        })

                        // Update metadata using configured columns
                        const timestampCol = tableConfig.timestamp_column
                        const idCol = tableConfig.id_column

                        if (timestampCol && record[timestampCol]) {
                            metadata.lastSyncTimestamp = new Date(
                                record[timestampCol]
                            ).getTime()
                        }
                        if (idCol && record[idCol]) {
                            metadata.lastSyncId = record[idCol]
                        }

                        syncedCount++
                    } catch (error) {
                        console.error(
                            `Error syncing record in table ${tableName}:`,
                            error,
                            {
                                record: row,
                                columns: result.columns,
                            }
                        )
                        // Continue with next record
                    }
                }

                console.log(
                    `Successfully synced ${syncedCount}/${result.rows.length} records for table ${tableName}`
                )
                await this.updateMetadata(tableName, metadata)
            }
        } catch (error) {
            console.error(`Error syncing table ${tableName}:`, error)
            // Update metadata with error
            const currentMetadata = this.tableMetadata.get(tableName) || {
                lastSyncTimestamp: 0,
                lastSyncId: undefined,
            }
            await this.updateMetadata(tableName, {
                ...currentMetadata,
                sync_errors: (error as Error).message,
            })
            throw error
        }
    }

    private generateCreateTableSQL(
        table: string,
        columns: ColumnDefinition[]
    ): string {
        const columnDefs = columns.map((col) => {
            const sqlType = this.syncSource.mapDataType(col.type)
            let definition = `${col.name} ${sqlType}`

            // Add nullable constraint
            if (col.nullable === false) {
                definition += ' NOT NULL'
            }

            // Add default value if specified
            if (col.defaultValue !== undefined) {
                definition += ` DEFAULT ${col.defaultValue}`
            }

            return definition
        })

        return `CREATE TABLE IF NOT EXISTS ${table} (${columnDefs.join(', ')})`
    }

    async destroy(): Promise<void> {
        // Clear all sync timeouts
        for (const [table, timeoutId] of this.syncTimeouts.entries()) {
            clearTimeout(timeoutId)
            this.syncTimeouts.delete(table)
        }
    }

    public async getMetadata(): Promise<{
        lastSyncTimestamp?: number
        sync_errors?: string
    } | null> {
        if (!this.dataSource) return null

        try {
            const result = (await this.dataSource.rpc.executeQuery({
                sql: 'SELECT last_sync_timestamp, sync_errors FROM tmp_data_sync_metadata LIMIT 1',
                params: [],
            })) as QueryResult

            if (result.rows.length === 0) return null

            return {
                lastSyncTimestamp: result.rows[0][0] as number,
                sync_errors: result.rows[0][1] as string,
            }
        } catch (error) {
            console.error('Error getting sync metadata:', error)
            return null
        }
    }

    public async setDataSource(dataSource: DataSource): Promise<void> {
        this.dataSource = dataSource
        await this.syncSource.setDataSource(dataSource)
        console.log('DataSyncPlugin: DataSource set', {
            hasDataSource: !!this.dataSource,
            hasExternal: !!this.dataSource?.external,
            dialect: this.dataSource?.external?.dialect,
        })
    }

    // Hook to transform queries before execution
    async beforeQuery(opts: {
        sql: string
        params?: unknown[]
    }): Promise<{ sql: string; params?: unknown[] }> {
        return {
            ...opts,
            sql: this.transformQuery(opts.sql),
        }
    }

    // Hook to handle query results
    async afterQuery(opts: {
        sql: string
        result: any
        isRaw: boolean
    }): Promise<any> {
        return opts.result
    }
}
