
import { StarbaseApp, StarbaseDBConfiguration } from '../../src/handler'
import { StarbasePlugin } from '../../src/plugin'
import { DataSource, ExternalDatabaseSource } from '../../src/types'
import { Context } from 'hono'

interface ReplicationConfig {
    interval: number
    tables: string[]
    lastReplicatedId: Record<string, number>
}

export class DataReplicatorPlugin extends StarbasePlugin {
    private config: StarbaseDBConfiguration | undefined
    private replicationConfig: ReplicationConfig
    private intervalId: NodeJS.Timeout | null = null
    private isRunning: boolean = false
    private dataSource: DataSource | null = null
    private app: StarbaseApp | null = null

    constructor() {
        super('starbasedb:data-replicator', {
            requiresAuth: false,
        })

        // Default configuration
        this.replicationConfig = {
            interval: parseInt(process.env.REPLICATION_INTERVAL || '300'), // 5 minutes by default
            tables: process.env.REPLICATION_TABLES?.split(',').map(t => t.trim()) || [],
            lastReplicatedId: {}
        }
    }

    override async register(app: StarbaseApp) {
        this.app = app

        app.use(async (c, next) => {
            this.config = c.get('config')
            this.dataSource = c.get('dataSource')
            await next()
        })

        // Initialize the replication tracking table
        await this.initializeTrackingTable()
    }

    private async initializeTrackingTable() {
        if (!this.dataSource) return

        // Create a table to track the last replicated ID for each table
        const createTableSql = `
            CREATE TABLE IF NOT EXISTS _replication_tracking (
                table_name TEXT PRIMARY KEY,
                last_replicated_id INTEGER DEFAULT 0,
                last_replicated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `

        try {
            await this.dataSource.rpc.query(createTableSql)
        } catch (error) {
            console.error('Error creating replication tracking table:', error)
        }
    }

    public startReplication() {
        if (this.isRunning || !this.dataSource) return

        this.isRunning = true
        this.replicateData()

        // Set up interval for periodic replication
        this.intervalId = setInterval(
            () => this.replicateData(),
            this.replicationConfig.interval * 1000
        )
    }

    public stopReplication() {
        if (!this.isRunning) return

        if (this.intervalId) {
            clearInterval(this.intervalId)
            this.intervalId = null
        }
        this.isRunning = false
    }

    private async replicateData() {
        if (!this.config) {
            console.error('DataReplicatorPlugin: No configuration available')
            return
        }

        const dataSource = this.getDataSource()
        if (!dataSource || !dataSource.external) {
            console.error('DataReplicatorPlugin: No external data source configured')
            return
        }

        try {
            // Get list of tables to replicate
            const tables = await this.getTablesToReplicate(dataSource.external)

            for (const table of tables) {
                await this.replicateTable(table, dataSource.external)
            }
        } catch (error) {
            console.error('Error during data replication:', error)
        }
    }

    private async getTablesToReplicate(externalSource: ExternalDatabaseSource): Promise<string[]> {
        // If specific tables are configured, use those
        if (this.replicationConfig.tables.length > 0) {
            return this.replicationConfig.tables
        }

        // Otherwise, get all tables from the external source
        try {
            let query = ''
            let schema = 'public' // Default schema for PostgreSQL

            switch (externalSource.dialect) {
                case 'postgresql':
                    query = `
                        SELECT table_name
                        FROM information_schema.tables
                        WHERE table_schema = $1
                        AND table_type = 'BASE TABLE'
                    `
                    if (externalSource.defaultSchema) {
                        schema = externalSource.defaultSchema
                    }
                    break
                case 'mysql':
                    query = 'SHOW TABLES'
                    break
                case 'sqlite':
                    query = "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
                    break
                default:
                    console.error(`Unsupported dialect for table listing: ${externalSource.dialect}`)
                    return []
            }

            // In a real implementation, you would execute this query on the external database
            // and return the list of tables
            console.log(`Querying external source for tables:`, query)

            // For now, return an empty array
            return []
        } catch (error) {
            console.error('Error getting tables from external source:', error)
            return []
        }
    }

    private async replicateTable(table: string, externalSource: ExternalDatabaseSource) {
        if (!this.dataSource) return

        // Get the last replicated ID for this table
        const lastId = await this.getLastReplicatedId(table)

        // Get new records from the external source
        const newRecords = await this.getNewRecords(table, externalSource, lastId)

        if (newRecords.length === 0) {
            return // No new records to replicate
        }

        // Create the table in SQLite if it doesn't exist
        await this.createTableIfNotExists(table, newRecords[0])

        // Insert the new records into SQLite
        await this.insertRecords(table, newRecords)

        // Update the last replicated ID
        const maxId = Math.max(...newRecords.map(record => record.id))
        await this.updateLastReplicatedId(table, maxId)
    }

    private async getLastReplicatedId(table: string): Promise<number> {
        const dataSource = this.getDataSource()
        if (!dataSource) return 0

        try {
            const result = await dataSource.rpc.query(`
                SELECT last_replicated_id FROM _replication_tracking
                WHERE table_name = ?
            `, [table])

            if (result && result.length > 0) {
                return result[0].last_replicated_id || 0
            }
        } catch (error) {
            console.error(`Error getting last replicated ID for table ${table}:`, error)
        }

        return 0
    }

    private async getNewRecords(table: string, externalSource: ExternalDatabaseSource, lastId: number) {
        if (!this.dataSource) return []

        try {
            // For different database types, we need to use different query approaches
            let query = ''
            let params: any[] = []

            switch (externalSource.dialect) {
                case 'postgresql':
                    query = `SELECT * FROM ${table} WHERE id > $1 ORDER BY id ASC`
                    params = [lastId]
                    break
                case 'mysql':
                    query = `SELECT * FROM ${table} WHERE id > ? ORDER BY id ASC`
                    params = [lastId]
                    break
                case 'sqlite':
                    // For SQLite-based external sources
                    if (externalSource.provider === 'turso') {
                        query = `SELECT * FROM ${table} WHERE id > ? ORDER BY id ASC`
                        params = [lastId]
                    } else if (externalSource.provider === 'cloudflare-d1') {
                        query = `SELECT * FROM ${table} WHERE id > ? ORDER BY id ASC`
                        params = [lastId]
                    } else {
                        // StarbaseDB
                        query = `SELECT * FROM ${table} WHERE id > ? ORDER BY id ASC`
                        params = [lastId]
                    }
                    break
                default:
                    console.error(`Unsupported dialect: ${externalSource.dialect}`)
                    return []
            }

            // Execute the query on the external source
            // Note: In a real implementation, you would need to establish a connection
            // to the external database and execute the query there
            console.log(`Querying external source for new records in table ${table}:`, query, params)

            // For now, return an empty array as we don't have a real connection to the external DB
            return []
        } catch (error) {
            console.error(`Error getting new records from table ${table}:`, error)
            return []
        }
    }

    private async createTableIfNotExists(table: string, sampleRecord: any) {
        if (!this.dataSource) return

        // Generate column definitions from the sample record
        const columns = Object.keys(sampleRecord).map(key => {
            const value = sampleRecord[key]
            let type = 'TEXT'

            if (typeof value === 'number') {
                type = Number.isInteger(value) ? 'INTEGER' : 'REAL'
            } else if (value instanceof Date) {
                type = 'TIMESTAMP'
            }

            return `${key} ${type}`
        }).join(', ')

        const createTableSql = `
            CREATE TABLE IF NOT EXISTS ${table} (
                ${columns},
                PRIMARY KEY (id)
            )
        `

        try {
            await dataSource.rpc.query(createTableSql)
        } catch (error) {
            console.error(`Error creating table ${table}:`, error)
        }
    }

    private async insertRecords(table: string, records: any[]) {
        if (!this.dataSource || records.length === 0) return

        // Prepare the insert statement
        const columns = Object.keys(records[0]).join(', ')
        const placeholders = records[0] ? Object.keys(records[0]).map(() => '?').join(', ') : ''

        const insertSql = `INSERT OR IGNORE INTO ${table} (${columns}) VALUES (${placeholders})`

        // Insert records in batches
        const batchSize = 100
        for (let i = 0; i < records.length; i += batchSize) {
            const batch = records.slice(i, i + batchSize)
            const values = batch.map(record => Object.values(record)).flat()

            try {
                await dataSource.rpc.query(insertSql, values)
            } catch (error) {
                console.error(`Error inserting records into table ${table}:`, error)
            }
        }
    }

    private async updateLastReplicatedId(table: string, lastId: number) {
        const dataSource = this.getDataSource()
        if (!dataSource) return

        try {
            // Check if the record exists
            const result = await dataSource.rpc.query(`
                SELECT 1 FROM _replication_tracking WHERE table_name = ?
            `, [table])

            if (result && result.length > 0) {
                // Update existing record
                await dataSource.rpc.query(`
                    UPDATE _replication_tracking
                    SET last_replicated_id = ?, last_replicated_at = CURRENT_TIMESTAMP
                    WHERE table_name = ?
                `, [lastId, table])
            } else {
                // Insert new record
                await dataSource.rpc.query(`
                    INSERT INTO _replication_tracking (table_name, last_replicated_id)
                    VALUES (?, ?)
                `, [table, lastId])
            }
        } catch (error) {
            console.error(`Error updating last replicated ID for table ${table}:`, error)
        }
    }
}
