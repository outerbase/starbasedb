import type { DataSource, DurableObjectBranded } from '../../src/types'

export interface PluginContext {
    env: Record<string, string>
    config: Record<string, any>
    internalDb: DataSource['rpc']
    externalDb?: DataSource['rpc']
}

export interface Plugin {
    initialize(context: PluginContext): Promise<void>
    shutdown(): Promise<void>
}

export interface ExternalDBConfig {
    type: string
    host?: string
    port?: number
    user?: string
    password?: string
    database?: string
    defaultSchema?: string
    mongodbUri?: string
    tursoUri?: string
    tursoToken?: string
    starbasedbUri?: string
    starbasedbToken?: string
    cloudflareApiKey?: string
    cloudflareAccountId?: string
    cloudflareDbId?: string
}

interface SyncMetadata {
    lastSyncTime: string
    tableMap: Record<string, TableSyncInfo>
}

interface TableSyncInfo {
    lastSyncValue: string | number | null
    externalSchema: any
    lastSyncCount: number
    totalSyncCount: number
    lastError?: string
    lastErrorTime?: string
}

class DataSyncPlugin implements Plugin {
    private context: PluginContext | null = null
    private config: any = {}
    private externalConfig: ExternalDBConfig | null = null
    private syncMetadata: SyncMetadata = {
        lastSyncTime: '',
        tableMap: {},
    }
    private syncInterval: NodeJS.Timeout | null = null
    private isSyncing = false

    async initialize(context: PluginContext): Promise<void> {
        this.context = context
        this.config = context.config || {}

        // Get external database configuration
        this.externalConfig = this.getExternalDBConfig()

        if (!this.externalConfig || !this.externalConfig.type) {
            console.warn('Data Sync Plugin: No external database configured')
            return
        }

        // Load sync metadata from internal database
        await this.loadSyncMetadata()

        // Start sync interval if enabled
        if (this.config.enabled !== false) {
            const intervalMinutes = this.config.sync_interval || 15
            console.log(
                `Data Sync Plugin: Starting sync interval (${intervalMinutes} minutes)`
            )

            // Run initial sync
            this.runSync().catch((err) => {
                console.error('Data Sync Plugin: Initial sync failed', err)
            })

            // Set up interval for future syncs
            this.syncInterval = setInterval(
                () => {
                    if (!this.isSyncing) {
                        this.runSync().catch((err) => {
                            console.error(
                                'Data Sync Plugin: Scheduled sync failed',
                                err
                            )
                        })
                    }
                },
                intervalMinutes * 60 * 1000
            )
        }
    }

    async shutdown(): Promise<void> {
        if (this.syncInterval) {
            clearInterval(this.syncInterval)
            this.syncInterval = null
        }
    }

    private getExternalDBConfig(): ExternalDBConfig | null {
        if (!this.context || !this.context.env) return null

        const env = this.context.env

        // Check if external DB is configured
        if (env.EXTERNAL_DB_TYPE) {
            return {
                type: env.EXTERNAL_DB_TYPE,
                host: env.EXTERNAL_DB_HOST,
                port: env.EXTERNAL_DB_PORT
                    ? parseInt(env.EXTERNAL_DB_PORT, 10)
                    : undefined,
                user: env.EXTERNAL_DB_USER,
                password: env.EXTERNAL_DB_PASS,
                database: env.EXTERNAL_DB_DATABASE,
                defaultSchema: env.EXTERNAL_DB_DEFAULT_SCHEMA || 'public',
                mongodbUri: env.EXTERNAL_DB_MONGODB_URI,
                tursoUri: env.EXTERNAL_DB_TURSO_URI,
                tursoToken: env.EXTERNAL_DB_TURSO_TOKEN,
                starbasedbUri: env.EXTERNAL_DB_STARBASEDB_URI,
                starbasedbToken: env.EXTERNAL_DB_STARBASEDB_TOKEN,
                cloudflareApiKey: env.EXTERNAL_DB_CLOUDFLARE_API_KEY,
                cloudflareAccountId: env.EXTERNAL_DB_CLOUDFLARE_ACCOUNT_ID,
                cloudflareDbId: env.EXTERNAL_DB_CLOUDFLARE_DATABASE_ID,
            }
        }

        return null
    }

    private async loadSyncMetadata(): Promise<void> {
        if (!this.context || !this.context.internalDb) return

        try {
            // Create metadata table if it doesn't exist
            await this.context.internalDb.executeQuery({
                sql: `CREATE TABLE IF NOT EXISTS data_sync_metadata (
          id TEXT PRIMARY KEY,
          data TEXT NOT NULL
        )`,
            })

            // Load metadata
            const result = await this.context.internalDb.executeQuery({
                sql: 'SELECT data FROM data_sync_metadata WHERE id = ?',
                params: ['sync_state'],
            })

            if (result && result.length > 0 && result[0].data) {
                this.syncMetadata = JSON.parse(result[0].data as string)
            }
        } catch (err) {
            console.error('Data Sync Plugin: Failed to load metadata', err)
        }
    }

    private async saveSyncMetadata(): Promise<void> {
        if (!this.context || !this.context.internalDb) return

        try {
            await this.context.internalDb.executeQuery({
                sql: 'INSERT OR REPLACE INTO data_sync_metadata (id, data) VALUES (?, ?)',
                params: ['sync_state', JSON.stringify(this.syncMetadata)],
            })
        } catch (err) {
            console.error('Data Sync Plugin: Failed to save metadata', err)
        }
    }

    private async runSync(): Promise<void> {
        if (this.isSyncing || !this.context || !this.externalConfig) return

        this.isSyncing = true
        console.log('Data Sync Plugin: Starting synchronization')

        try {
            // Update last sync time
            this.syncMetadata.lastSyncTime = new Date().toISOString()

            // Get list of tables to sync
            const tables = await this.getTableList()

            // Filter tables if specified in config
            const tablesToSync =
                this.config.tables && this.config.tables.length > 0
                    ? tables.filter((table) =>
                          this.config.tables.includes(table)
                      )
                    : tables

            console.log(
                `Data Sync Plugin: Found ${tablesToSync.length} tables to sync`
            )

            // Sync each table
            for (const table of tablesToSync) {
                await this.syncTable(table)
            }

            // Save metadata
            await this.saveSyncMetadata()

            console.log('Data Sync Plugin: Synchronization completed')
        } catch (err) {
            console.error('Data Sync Plugin: Synchronization failed', err)
        } finally {
            this.isSyncing = false
        }
    }

    private async getTableList(): Promise<string[]> {
        if (!this.context || !this.context.externalDb) {
            return []
        }

        try {
            let tables: string[] = []

            switch (this.externalConfig?.type) {
                case 'postgresql':
                    const schema = this.externalConfig.defaultSchema || 'public'
                    const result = await this.context.externalDb.executeQuery({
                        sql: `SELECT table_name FROM information_schema.tables 
                 WHERE table_schema = $1 AND table_type = 'BASE TABLE'`,
                        params: [schema],
                    })
                    tables = result.map((row) => String(row.table_name))
                    break

                case 'mysql':
                    const mysqlResult =
                        await this.context.externalDb.executeQuery({
                            sql: `SELECT table_name FROM information_schema.tables 
                 WHERE table_schema = ?`,
                            params: [this.externalConfig.database],
                        })
                    tables = mysqlResult.map((row) => String(row.table_name))
                    break

                case 'mongodb':
                    // For MongoDB, we need to list collections
                    const collections =
                        await this.context.externalDb.executeQuery({
                            sql: 'SHOW COLLECTIONS',
                            isRaw: true,
                        })
                    tables = collections.map((col) => String(col.name))
                    break

                default:
                    console.warn(
                        `Data Sync Plugin: Unsupported database type: ${this.externalConfig?.type}`
                    )
            }

            return tables
        } catch (err) {
            console.error('Data Sync Plugin: Failed to get table list', err)
            return []
        }
    }

    private async syncTable(tableName: string): Promise<void> {
        if (
            !this.context ||
            !this.context.externalDb ||
            !this.context.internalDb
        ) {
            return
        }

        console.log(`Data Sync Plugin: Syncing table ${tableName}`)

        try {
            // Get or initialize table sync info
            if (!this.syncMetadata.tableMap[tableName]) {
                this.syncMetadata.tableMap[tableName] = {
                    lastSyncValue: null,
                    externalSchema: null,
                    lastSyncCount: 0,
                    totalSyncCount: 0,
                }
            }

            const tableInfo = this.syncMetadata.tableMap[tableName]

            // Get external schema if not already cached
            if (!tableInfo.externalSchema) {
                tableInfo.externalSchema = await this.getTableSchema(tableName)
            }

            // Create or update internal table schema
            await this.ensureInternalTable(tableName, tableInfo.externalSchema)

            // Determine tracking column and type
            const trackColumn = this.config.track_column || 'created_at'
            let trackColumnType = 'string'

            if (tableInfo.externalSchema) {
                const column = tableInfo.externalSchema.find(
                    (col: any) => col.name === trackColumn
                )
                if (column) {
                    trackColumnType = this.getColumnType(column.type)
                }
            }

            // Fetch and sync data in batches
            const batchSize = this.config.batch_size || 1000
            let hasMoreData = true
            let totalSynced = 0

            while (hasMoreData) {
                const { data, hasMore } = await this.fetchBatch(
                    tableName,
                    trackColumn,
                    tableInfo.lastSyncValue,
                    trackColumnType,
                    batchSize
                )

                hasMoreData = hasMore

                if (data.length > 0) {
                    await this.insertBatch(
                        tableName,
                        data,
                        tableInfo.externalSchema
                    )

                    // Update last sync value
                    const lastItem = data[data.length - 1]
                    tableInfo.lastSyncValue = lastItem[trackColumn]

                    totalSynced += data.length

                    // Update sync metadata
                    tableInfo.lastSyncCount = data.length
                    tableInfo.totalSyncCount += data.length

                    // Save metadata after each batch to ensure we don't lose progress
                    await this.saveSyncMetadata()
                }
            }

            console.log(
                `Data Sync Plugin: Synced ${totalSynced} records for table ${tableName}`
            )
        } catch (err) {
            console.error(
                `Data Sync Plugin: Error syncing table ${tableName}`,
                err
            )

            // Record error in metadata
            if (this.syncMetadata.tableMap[tableName]) {
                this.syncMetadata.tableMap[tableName].lastError =
                    err instanceof Error ? err.message : String(err)
                this.syncMetadata.tableMap[tableName].lastErrorTime =
                    new Date().toISOString()
                await this.saveSyncMetadata()
            }
        }
    }

    private async getTableSchema(tableName: string): Promise<any[]> {
        if (!this.context || !this.context.externalDb || !this.externalConfig) {
            return []
        }

        try {
            let schema: any[] = []

            switch (this.externalConfig.type) {
                case 'postgresql':
                    const schemaName =
                        this.externalConfig.defaultSchema || 'public'
                    const result = await this.context.externalDb.executeQuery({
                        sql: `SELECT column_name as name, data_type as type, 
                 is_nullable as nullable, column_default as default_value
                 FROM information_schema.columns 
                 WHERE table_schema = $1 AND table_name = $2
                 ORDER BY ordinal_position`,
                        params: [schemaName, tableName],
                    })
                    schema = result.map((row) => ({
                        name: String(row.name),
                        type: String(row.type),
                        nullable: String(row.nullable),
                        default_value: row.default_value,
                    }))
                    break

                case 'mysql':
                    const mysqlResult =
                        await this.context.externalDb.executeQuery({
                            sql: `SELECT column_name as name, data_type as type, 
                 is_nullable as nullable, column_default as default_value
                 FROM information_schema.columns 
                 WHERE table_schema = ? AND table_name = ?
                 ORDER BY ordinal_position`,
                            params: [this.externalConfig.database, tableName],
                        })
                    schema = mysqlResult
                    break

                case 'mongodb':
                    // For MongoDB, we need to infer schema from data
                    const sample = await this.context.externalDb.executeQuery({
                        sql: `db.${tableName}.find().limit(1)`,
                        isRaw: true,
                    })

                    if (sample.length > 0) {
                        schema = Object.entries(sample[0]).map(
                            ([key, value]) => ({
                                name: key,
                                type: typeof value,
                                nullable: true,
                                default_value: null,
                            })
                        )
                    }
                    break

                default:
                    console.warn(
                        `Data Sync Plugin: Unsupported database type for schema: ${this.externalConfig.type}`
                    )
            }

            return schema
        } catch (err) {
            console.error(
                `Data Sync Plugin: Failed to get schema for table ${tableName}`,
                err
            )
            return []
        }
    }

    private async ensureInternalTable(
        tableName: string,
        schema: any[]
    ): Promise<void> {
        if (
            !this.context ||
            !this.context.internalDb ||
            !schema ||
            schema.length === 0
        ) {
            return
        }

        try {
            // Check if table exists
            const tableExists = await this.context.internalDb.executeQuery({
                sql: `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
                params: [tableName],
            })

            if (tableExists && tableExists.length > 0 && tableExists[0].name) {
                // Table exists, check if we need to add columns
                const existingColumns =
                    await this.context.internalDb.executeQuery({
                        sql: `PRAGMA table_info(${tableName})`,
                    })

                const existingColumnNames = existingColumns.map(
                    (col: any) => col.name
                )

                for (const column of schema) {
                    if (!existingColumnNames.includes(column.name)) {
                        // Add missing column
                        const sqliteType = this.getSqliteType(column.type)
                        await this.context.internalDb.executeQuery({
                            sql: `ALTER TABLE ${tableName} ADD COLUMN ${column.name} ${sqliteType}`,
                            params: [],
                        })
                        console.log(
                            `Data Sync Plugin: Added column ${column.name} to table ${tableName}`
                        )
                    }
                }
            } else {
                // Create new table
                const columnDefs = schema
                    .map((column) => {
                        const sqliteType = this.getSqliteType(column.type)
                        return `${column.name} ${sqliteType}`
                    })
                    .join(', ')

                await this.context.internalDb.executeQuery({
                    sql: `CREATE TABLE ${tableName} (${columnDefs})`,
                    params: [],
                })

                console.log(`Data Sync Plugin: Created table ${tableName}`)
            }
        } catch (err) {
            console.error(
                `Data Sync Plugin: Failed to ensure internal table ${tableName}`,
                err
            )
            throw err
        }
    }

    private getSqliteType(externalType: string): string {
        // Convert external database types to SQLite types
        const type = externalType.toLowerCase()

        if (type.includes('int') || type.includes('serial')) {
            return 'INTEGER'
        } else if (
            type.includes('float') ||
            type.includes('double') ||
            type.includes('decimal') ||
            type.includes('numeric')
        ) {
            return 'REAL'
        } else if (type.includes('bool')) {
            return 'INTEGER' // SQLite doesn't have boolean, use INTEGER (0/1)
        } else if (type.includes('date') || type.includes('time')) {
            return 'TEXT' // Store dates as ISO strings
        } else if (type.includes('json') || type.includes('jsonb')) {
            return 'TEXT' // Store JSON as text
        } else {
            return 'TEXT' // Default to TEXT for other types
        }
    }

    private getColumnType(externalType: string): string {
        // Determine if column is string, number, or date for comparison purposes
        const type = externalType.toLowerCase()

        if (
            type.includes('int') ||
            type.includes('float') ||
            type.includes('double') ||
            type.includes('decimal') ||
            type.includes('numeric') ||
            type.includes('serial')
        ) {
            return 'number'
        } else if (type.includes('date') || type.includes('time')) {
            return 'date'
        } else {
            return 'string'
        }
    }

    private async fetchBatch(
        tableName: string,
        trackColumn: string,
        lastValue: string | number | null,
        trackColumnType: string,
        batchSize: number
    ): Promise<{ data: any[]; hasMore: boolean }> {
        if (!this.context?.externalDb) {
            return { data: [], hasMore: false }
        }

        try {
            let query = `SELECT * FROM ${tableName}`
            const params: any[] = []

            if (lastValue !== null) {
                const operator = trackColumnType === 'string' ? '>' : '>='
                query += ` WHERE ${trackColumn} ${operator} ?`
                params.push(lastValue)
            }

            query += ` ORDER BY ${trackColumn} ASC LIMIT ${batchSize + 1}`

            const result = await this.context.externalDb.executeQuery({
                sql: query,
                params,
            })

            const hasMore = result.length > batchSize
            const data = hasMore ? result.slice(0, -1) : result

            return { data, hasMore }
        } catch (err) {
            console.error(
                `Data Sync Plugin: Error fetching batch for table ${tableName}`,
                err
            )
            throw err
        }
    }

    private async insertBatch(
        tableName: string,
        data: any[],
        schema: any[]
    ): Promise<void> {
        if (!this.context || !this.context.internalDb) return

        try {
            const columns = schema.map((col) => col.name).join(', ')
            const placeholders = data
                .map(() => `(${schema.map(() => '?').join(', ')})`)
                .join(', ')

            const values = data.flatMap((row) =>
                schema.map((col) => row[col.name])
            )

            await this.context.internalDb.executeQuery({
                sql: `INSERT OR REPLACE INTO ${tableName} (${columns}) VALUES ${placeholders}`,
                params: values,
            })
        } catch (err) {
            console.error(
                `Data Sync Plugin: Error inserting batch for table ${tableName}`,
                err
            )
            throw err
        }
    }

    // Public methods for external control
    public async triggerSync(): Promise<void> {
        if (!this.isSyncing) {
            await this.runSync()
        }
    }

    public async resetSyncState(tableName?: string): Promise<void> {
        if (tableName) {
            delete this.syncMetadata.tableMap[tableName]
        } else {
            this.syncMetadata.tableMap = {}
        }
        await this.saveSyncMetadata()
    }

    public getSyncStatus(): SyncMetadata {
        return { ...this.syncMetadata }
    }
}

// Export the plugin class
export default DataSyncPlugin
