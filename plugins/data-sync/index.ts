import {
    StarbaseApp,
    StarbaseContext,
    StarbaseDBConfiguration,
} from '../../src/handler'
import { StarbasePlugin } from '../../src/plugin'
import { DataSource } from '../../src/types'

interface SyncConfig {
    sync_interval: number
    tables: string[]
}

interface TableMetadata {
    lastSyncTimestamp: number
    lastSyncId?: string | number
}

interface QueryResult {
    rows: any[][]
    columns: string[]
}

interface MetadataRow {
    table_name: string
    last_sync_timestamp: number
    last_sync_id: string
}

declare global {
    interface Window {
        setTimeout: typeof setTimeout
        clearTimeout: typeof clearTimeout
        console: typeof console
    }
}

export class DataSyncPlugin extends StarbasePlugin {
    private config: SyncConfig
    private syncInterval: number
    private syncTimeouts: Map<string, ReturnType<typeof setTimeout>> = new Map()
    private tableMetadata: Map<string, TableMetadata> = new Map()
    private dataSource?: DataSource

    constructor(opts?: { sync_interval?: number; tables?: string[] }) {
        super('starbasedb:data-sync', {
            requiresAuth: true,
        })

        this.config = {
            sync_interval: opts?.sync_interval || 300,
            tables: opts?.tables || [],
        }
        this.syncInterval = this.config.sync_interval * 1000 // Convert to milliseconds
    }

    override async register(app: StarbaseApp): Promise<void> {
        app.use(async (c: StarbaseContext, next: () => Promise<void>) => {
            this.dataSource = c?.get('dataSource')

            // Create metadata table if it doesn't exist
            await this.dataSource?.rpc.executeQuery({
                sql: `
          CREATE TABLE IF NOT EXISTS data_sync_metadata (
            table_name TEXT PRIMARY KEY,
            last_sync_timestamp INTEGER,
            last_sync_id TEXT
          )
        `,
                params: [],
            })

            await next()
        })

        // Load existing metadata
        await this.loadMetadata()

        // Start sync for configured tables
        for (const table of this.config.tables) {
            await this.scheduleSyncForTable(table)
        }
    }

    private async loadMetadata(): Promise<void> {
        if (!this.dataSource) return

        const result = (await this.dataSource.rpc.executeQuery({
            sql: 'SELECT table_name, last_sync_timestamp, last_sync_id FROM data_sync_metadata',
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
            sql: `INSERT OR REPLACE INTO data_sync_metadata (table_name, last_sync_timestamp, last_sync_id)
            VALUES (?, ?, ?)`,
            params: [
                table,
                metadata.lastSyncTimestamp,
                metadata.lastSyncId?.toString(),
            ],
        })
        this.tableMetadata.set(table, metadata)
    }

    private async scheduleSyncForTable(table: string): Promise<void> {
        const sync = async () => {
            try {
                await this.syncTable(table)
            } catch (error) {
                console.error(`Error syncing table ${table}:`, error)
            }

            // Schedule next sync
            const timeoutId = setTimeout(() => sync(), this.syncInterval)
            this.syncTimeouts.set(table, timeoutId)
        }

        await sync()
    }

    private async syncTable(table: string): Promise<void> {
        if (!this.dataSource?.external) return

        const metadata = this.tableMetadata.get(table) || {
            lastSyncTimestamp: 0,
            lastSyncId: undefined,
        }

        // Get table structure from external database
        const tableInfo = (await this.dataSource.rpc.executeQuery({
            sql: `SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = ?`,
            params: [table],
        })) as QueryResult

        // Create table in internal database if it doesn't exist
        const createTableSQL = this.generateCreateTableSQL(
            table,
            tableInfo.rows
        )
        await this.dataSource.rpc.executeQuery({
            sql: createTableSQL,
            params: [],
        })

        // Fetch new records from external database
        let query = `SELECT * FROM ${table} WHERE created_at > ?`
        const params = [new Date(metadata.lastSyncTimestamp).toISOString()]

        if (metadata.lastSyncId) {
            query += ` OR id > ?`
            params.push(metadata.lastSyncId.toString())
        }

        query += ` ORDER BY created_at ASC LIMIT 1000`
        const result = (await this.dataSource.rpc.executeQuery({
            sql: query,
            params,
        })) as QueryResult

        if (result.rows.length > 0) {
            // Insert new records into internal database
            for (const row of result.rows) {
                const record = row.reduce((obj: any, val: any, idx: number) => {
                    obj[result.columns[idx]] = val
                    return obj
                }, {})

                const columns = Object.keys(record)
                const values = Object.values(record)
                const placeholders = Array(values.length).fill('?').join(',')

                await this.dataSource.rpc.executeQuery({
                    sql: `INSERT OR REPLACE INTO ${table} (${columns.join(',')}) VALUES (${placeholders})`,
                    params: values,
                })

                // Update metadata
                metadata.lastSyncTimestamp = new Date(
                    record.created_at
                ).getTime()
                metadata.lastSyncId = record.id
            }

            await this.updateMetadata(table, metadata)
        }
    }

    private generateCreateTableSQL(table: string, rows: any[][]): string {
        const columnDefs = rows.map((row) => {
            const columnName = row[0]
            const dataType = row[1]
            const sqlType = this.mapDataType(dataType)
            return `${columnName} ${sqlType}`
        })

        return `CREATE TABLE IF NOT EXISTS ${table} (${columnDefs.join(', ')})`
    }

    private mapDataType(pgType: string): string {
        // Map PostgreSQL types to SQLite types
        const typeMap: { [key: string]: string } = {
            integer: 'INTEGER',
            bigint: 'INTEGER',
            text: 'TEXT',
            varchar: 'TEXT',
            char: 'TEXT',
            boolean: 'INTEGER',
            timestamp: 'TEXT',
            date: 'TEXT',
            numeric: 'REAL',
            decimal: 'REAL',
            real: 'REAL',
            'double precision': 'REAL',
            json: 'TEXT',
            jsonb: 'TEXT',
        }

        return typeMap[pgType.toLowerCase()] || 'TEXT'
    }

    async destroy(): Promise<void> {
        // Clear all sync timeouts
        for (const [table, timeoutId] of this.syncTimeouts.entries()) {
            clearTimeout(timeoutId)
            this.syncTimeouts.delete(table)
        }
    }
}
