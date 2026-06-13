import { StarbaseApp, StarbaseDBConfiguration } from '../../src/handler'
import { StarbasePlugin } from '../../src/plugin'
import { DataSource } from '../../src/types'
import { executeSDKQuery } from '../../src/operation'
import { CronPlugin } from '../cron'

export class ReplicationPlugin extends StarbasePlugin {
    private cronPlugin: CronPlugin
    private dataSource?: DataSource
    private config?: StarbaseDBConfiguration
    private env: any
    private isRunning: boolean = false

    constructor(opts: { cronPlugin: CronPlugin }) {
        super('starbasedb:replication', {
            requiresAuth: false,
        })
        this.cronPlugin = opts.cronPlugin
    }

    override async register(app: StarbaseApp) {
        // Hono middleware to intercept and initialize context
        app.use(async (c, next) => {
            this.dataSource = c.get('dataSource')
            this.config = c.get('config')
            this.env = c.env as any

            if (
                this.env?.EXTERNAL_DB_TYPE &&
                this.env?.EXTERNAL_DB_TABLES_TO_TRACK
            ) {
                await this.initReplicationState()
                await this.registerCronTask(c)
            }

            await next()
        })

        // Listen for the replication cron event
        this.cronPlugin.onEvent(async (event) => {
            if (event.name === 'database-replication') {
                await this.runReplication()
            }
        })
    }

    /**
     * Initialize the SQLite table that keeps track of replication watermark state
     */
    private async initReplicationState() {
        if (!this.dataSource) return

        const createTableSQL = `
            CREATE TABLE IF NOT EXISTS tmp_replication_state (
                table_name TEXT PRIMARY KEY,
                last_synced_id TEXT,
                last_synced_at TEXT,
                is_syncing INTEGER DEFAULT 0
            )
        `
        await this.dataSource.rpc.executeQuery({
            sql: createTableSQL,
            params: [],
        })
    }

    /**
     * Register the database-replication task in tmp_cron_tasks if it doesn't exist
     */
    private async registerCronTask(c: any) {
        if (!this.dataSource) return

        const tables = this.env.EXTERNAL_DB_TABLES_TO_TRACK
        if (!tables) return

        const pollingInterval =
            this.env.EXTERNAL_DB_POLLING_INTERVAL || '*/1 * * * *'
        const url = new URL(c.req.url)
        const callbackHost = `${url.protocol}//${url.host}`

        // Check if task already exists with same config
        const result = (await this.dataSource.rpc.executeQuery({
            sql: 'SELECT name, cron_tab, callback_host FROM tmp_cron_tasks WHERE name = ?',
            params: ['database-replication'],
        })) as any[]

        if (result && result.length > 0) {
            const task = result[0]
            if (
                task.cron_tab === pollingInterval &&
                task.callback_host === callbackHost
            ) {
                // Already configured correctly, do not overwrite to prevent resetting alarm execution
                return
            }
        }

        // Add event using cron plugin
        await this.cronPlugin.addEvent(
            pollingInterval,
            'database-replication',
            {},
            callbackHost
        )
    }

    /**
     * Run replication logic for all configured tables
     */
    public async runReplication() {
        if (this.isRunning) {
            console.log('Database replication is already running. Skipping.')
            return
        }

        if (!this.dataSource || !this.config || !this.env) {
            console.warn('ReplicationPlugin not properly initialized.')
            return
        }

        const tablesToTrack = this.env.EXTERNAL_DB_TABLES_TO_TRACK
        if (!tablesToTrack) return

        const tables = tablesToTrack.split(',').map((t: string) => t.trim())
        const batchSize = Number(this.env.EXTERNAL_DB_BATCH_SIZE) || 500

        this.isRunning = true
        let needsFollowUp = false

        try {
            for (const table of tables) {
                try {
                    const moreData = await this.replicateTable(table, batchSize)
                    if (moreData) {
                        needsFollowUp = true
                    }
                } catch (error) {
                    console.error(`Error replicating table ${table}:`, error)
                }
            }

            // Yield control/respect Cloudflare limits: If more data needs to be synced,
            // reschedule the alarm to run again immediately (in 1 second)
            if (needsFollowUp) {
                console.log(
                    'More data available for replication. Rescheduling alarm in 1s.'
                )
                await this.dataSource.rpc.setAlarm(Date.now() + 1000)
            }
        } finally {
            this.isRunning = false
        }
    }

    /**
     * Replicates a single table's batch. Returns true if there is more data to sync.
     */
    private async replicateTable(
        tableName: string,
        batchSize: number
    ): Promise<boolean> {
        const external = this.dataSource?.external
        if (!external) {
            throw new Error('No external database connection configured.')
        }

        const dialect = external.dialect

        // 1. Get columns and types of external table
        let schemaQuery = ''
        let schemaParams: any[] = []

        if (dialect === 'postgresql') {
            schemaQuery = `
                SELECT column_name, data_type, is_nullable 
                FROM information_schema.columns 
                WHERE table_schema = $1 AND table_name = $2
            `
            schemaParams = [external.defaultSchema || 'public', tableName]
        } else if (dialect === 'mysql') {
            schemaQuery = `
                SELECT column_name as COLUMN_NAME, data_type as DATA_TYPE, is_nullable as IS_NULLABLE 
                FROM information_schema.columns 
                WHERE table_schema = ? AND table_name = ?
            `
            schemaParams = [external.database, tableName]
        } else {
            // sqlite
            schemaQuery = `PRAGMA table_info(${tableName})`
            schemaParams = []
        }

        const schemaResult = await executeSDKQuery({
            sql: schemaQuery,
            params: schemaParams,
            dataSource: this.dataSource!,
            config: this.config!,
        })

        if (!schemaResult || schemaResult.length === 0) {
            throw new Error(
                `Could not retrieve schema for external table ${tableName}`
            )
        }

        // Normalize schema format
        let columns: {
            name: string
            type: string
            nullable: boolean
            isPrimaryKey?: boolean
        }[] = []
        if (dialect === 'postgresql' || dialect === 'mysql') {
            columns = schemaResult.map((r: any) => ({
                name: r.column_name || r.COLUMN_NAME,
                type: r.data_type || r.DATA_TYPE,
                nullable: (r.is_nullable || r.IS_NULLABLE) === 'YES',
                isPrimaryKey: (r.column_name || r.COLUMN_NAME) === 'id',
            }))
        } else {
            // sqlite
            columns = schemaResult.map((r: any) => ({
                name: r.name,
                type: r.type,
                nullable: r.notnull === 0,
                isPrimaryKey: r.pk > 0,
            }))
        }

        // 2. Ensure local table exists
        const columnDefs = columns.map((c) => {
            let def = `"${c.name}" ${this.mapToSQLiteType(c.type)}`
            if (c.isPrimaryKey) {
                def += ' PRIMARY KEY'
            }
            if (!c.nullable) {
                def += ' NOT NULL'
            }
            return def
        })

        const createTableSQL = `CREATE TABLE IF NOT EXISTS "${tableName}" (${columnDefs.join(', ')})`
        await this.dataSource!.rpc.executeQuery({ sql: createTableSQL })

        // Check for missing columns in local table (dynamic schema migration)
        const localInfo = (await this.dataSource!.rpc.executeQuery({
            sql: `PRAGMA table_info("${tableName}")`,
            params: [],
        })) as any[]

        if (localInfo && localInfo.length > 0) {
            const localColNames = new Set(
                localInfo.map((r: any) => r.name.toLowerCase())
            )
            for (const col of columns) {
                if (!localColNames.has(col.name.toLowerCase())) {
                    let alterSQL = `ALTER TABLE "${tableName}" ADD COLUMN "${col.name}" ${this.mapToSQLiteType(col.type)}`
                    console.log(
                        `Adding missing column ${col.name} to local table ${tableName}`
                    )
                    await this.dataSource!.rpc.executeQuery({ sql: alterSQL })
                }
            }
        }

        // 3. Read replication state (last_synced_id / last_synced_at)
        const stateResult = (await this.dataSource!.rpc.executeQuery({
            sql: 'SELECT last_synced_id, last_synced_at FROM tmp_replication_state WHERE table_name = ?',
            params: [tableName],
        })) as any[]

        let lastSyncedId: any = null
        let lastSyncedAt: string | null = null

        if (stateResult && stateResult.length > 0) {
            lastSyncedId = stateResult[0].last_synced_id
            lastSyncedAt = stateResult[0].last_synced_at || null
        }

        // 4. Build polling query based on columns
        const pkCol =
            columns.find((c) => c.isPrimaryKey)?.name ||
            columns.find((c) => c.name.toLowerCase() === 'id')?.name
        const hasIntId = columns.some(
            (c) =>
                c.name.toLowerCase() === 'id' &&
                this.mapToSQLiteType(c.type) === 'INTEGER'
        )
        const hasUpdatedAt = columns.some(
            (c) => c.name.toLowerCase() === 'updated_at'
        )

        let fetchSQL = ''
        let fetchParams: any[] = []

        if (hasUpdatedAt && pkCol) {
            const timeVal = lastSyncedAt || '1970-01-01T00:00:00.000Z'
            if (!lastSyncedAt) {
                if (dialect === 'postgresql') {
                    fetchSQL = `SELECT * FROM "${tableName}" ORDER BY updated_at ASC, "${pkCol}" ASC LIMIT $1`
                } else {
                    fetchSQL = `SELECT * FROM \`${tableName}\` ORDER BY updated_at ASC, \`${pkCol}\` ASC LIMIT ?`
                }
                fetchParams = [batchSize]
            } else {
                if (dialect === 'postgresql') {
                    fetchSQL = `SELECT * FROM "${tableName}" WHERE updated_at > $1 OR (updated_at = $2 AND "${pkCol}" > $3) ORDER BY updated_at ASC, "${pkCol}" ASC LIMIT $4`
                } else {
                    fetchSQL = `SELECT * FROM \`${tableName}\` WHERE updated_at > ? OR (updated_at = ? AND \`${pkCol}\` > ?) ORDER BY updated_at ASC, \`${pkCol}\` ASC LIMIT ?`
                }
                fetchParams = [timeVal, timeVal, lastSyncedId || '', batchSize]
            }
        } else if (hasIntId) {
            if (dialect === 'postgresql') {
                fetchSQL = `SELECT * FROM "${tableName}" WHERE id > $1 ORDER BY id ASC LIMIT $2`
            } else {
                fetchSQL = `SELECT * FROM \`${tableName}\` WHERE id > ? ORDER BY id ASC LIMIT ?`
            }
            fetchParams = [Number(lastSyncedId || 0), batchSize]
        } else {
            // Full scan fallback
            if (dialect === 'postgresql') {
                fetchSQL = `SELECT * FROM "${tableName}" LIMIT $1`
            } else {
                fetchSQL = `SELECT * FROM \`${tableName}\` LIMIT ?`
            }
            fetchParams = [batchSize]
        }

        const rows = await executeSDKQuery({
            sql: fetchSQL,
            params: fetchParams,
            dataSource: this.dataSource!,
            config: this.config!,
        })

        if (!rows || rows.length === 0) {
            // Sync hard deletions when table is up to date
            await this.syncDeletions(tableName, columns)
            return false
        }

        // 5. Schema mapping of values and insert into local SQLite
        const colNames = columns.map((c) => c.name)
        const placeholders = colNames.map(() => '?').join(', ')
        const insertSQL = `INSERT OR REPLACE INTO "${tableName}" (${colNames.map((c) => `"${c}"`).join(', ')}) VALUES (${placeholders})`

        const insertQueries = rows.map((row: any) => {
            const params = colNames.map((col) => {
                let val = row[col]
                if (val === undefined) {
                    val = null
                }
                if (val !== null && typeof val === 'object') {
                    if (val instanceof Date) {
                        return val.toISOString()
                    }
                    return JSON.stringify(val)
                }
                if (typeof val === 'boolean') {
                    return val ? 1 : 0
                }
                if (typeof val === 'bigint') {
                    return Number(val)
                }
                return val
            })
            return { sql: insertSQL, params }
        })

        await (this.dataSource!.rpc as any).executeTransaction(
            insertQueries,
            false
        )

        // 6. Update replication watermark state
        let nextSyncedId = lastSyncedId
        let nextSyncedAt = lastSyncedAt

        const lastRow = rows[rows.length - 1] as any
        if (pkCol && lastRow[pkCol] !== undefined) {
            nextSyncedId = String(lastRow[pkCol])
        }
        if (hasUpdatedAt && lastRow.updated_at !== undefined) {
            const val = lastRow.updated_at
            nextSyncedAt = val ? new Date(val as any).toISOString() : null
        }

        await this.dataSource!.rpc.executeQuery({
            sql: `INSERT OR REPLACE INTO tmp_replication_state (table_name, last_synced_id, last_synced_at, is_syncing) VALUES (?, ?, ?, 0)`,
            params: [tableName, nextSyncedId, nextSyncedAt],
        })

        // Return true if we hit the batch limit, implying more data might be available
        return rows.length === batchSize
    }

    /**
     * Handles hard deletions by comparing active IDs in the source to SQLite IDs
     */
    private async syncDeletions(tableName: string, columns: any[]) {
        const pkCol =
            columns.find((c) => c.isPrimaryKey)?.name ||
            columns.find((c) => c.name.toLowerCase() === 'id')?.name
        if (!pkCol) return // Skip if table has no primary key column

        const external = this.dataSource?.external
        if (!external) return

        const dialect = external.dialect
        let idQuery = ''
        if (dialect === 'postgresql') {
            idQuery = `SELECT "${pkCol}" FROM "${tableName}"`
        } else {
            idQuery = `SELECT \`${pkCol}\` FROM \`${tableName}\``
        }

        const extRows = await executeSDKQuery({
            sql: idQuery,
            params: [],
            dataSource: this.dataSource!,
            config: this.config!,
        })

        if (!extRows) return

        const extIdsSet = new Set(extRows.map((r: any) => r[pkCol]))

        // Get local SQLite IDs
        const localRows = (await this.dataSource!.rpc.executeQuery({
            sql: `SELECT "${pkCol}" FROM "${tableName}"`,
            params: [],
        })) as any[]

        if (!localRows || localRows.length === 0) return

        const idsToDelete = localRows
            .map((r: any) => r[pkCol])
            .filter((id) => !extIdsSet.has(id))

        if (idsToDelete.length > 0) {
            console.log(
                `Deleting ${idsToDelete.length} rows in local SQLite for table ${tableName} (hard deletes)`
            )
            for (let i = 0; i < idsToDelete.length; i += 500) {
                const chunk = idsToDelete.slice(i, i + 500)
                const placeholders = chunk.map(() => '?').join(', ')
                await this.dataSource!.rpc.executeQuery({
                    sql: `DELETE FROM "${tableName}" WHERE "${pkCol}" IN (${placeholders})`,
                    params: chunk,
                })
            }
        }
    }

    /**
     * Maps database types to SQLite column types
     */
    private mapToSQLiteType(externalType: string): string {
        const type = externalType.toLowerCase()
        if (
            type.includes('int') ||
            type.includes('bool') ||
            type.includes('boolean')
        ) {
            return 'INTEGER'
        }
        if (
            type.includes('char') ||
            type.includes('text') ||
            type.includes('uuid') ||
            type.includes('time') ||
            type.includes('date') ||
            type.includes('json')
        ) {
            return 'TEXT'
        }
        if (
            type.includes('double') ||
            type.includes('real') ||
            type.includes('numeric') ||
            type.includes('float')
        ) {
            return 'REAL'
        }
        return 'BLOB'
    }
}
