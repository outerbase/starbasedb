import { StarbaseApp } from '../../src/handler'
import { StarbasePlugin } from '../../src/plugin'
import { DataSource, QueryResult } from '../../src/types'
import { createResponse } from '../../src/utils'

export interface TableReplicationConfig {
    /** Name of the table in the external database (can be schema-qualified, e.g. "public.users") */
    name: string
    /** Target table name in the internal SQLite database (defaults to the table name without schema) */
    targetTable?: string
    /** Column used for incremental sync cursor tracking (e.g. "id", "updated_at", "created_at") */
    cursorColumn?: string
    /** Primary key for local upsert conflict resolution (defaults to "id") */
    primaryKey?: string
    /** Batch size of rows to pull per iteration (defaults to 500, clamped between 1 and 5000) */
    batchSize?: number
    /** Sync interval in seconds for background replication (defaults to plugin default) */
    syncIntervalSeconds?: number
    /** Optional SQL filter condition applied to external query (e.g. "is_active = true") */
    whereClause?: string
    /** Specific columns to pull (defaults to all columns: "*") */
    columns?: string[]
}

export interface ReplicationPluginOptions {
    /** Pre-configured table replication settings */
    tables?: TableReplicationConfig[]
    /** Default sync interval in seconds */
    defaultIntervalSeconds?: number
    /** Automatically create the destination table in SQLite if it does not exist */
    autoCreateTable?: boolean
    /** Whether endpoints require authentication (defaults to true) */
    requiresAuth?: boolean
}

export interface TableSyncState {
    table_name: string
    cursor_value: string | null
    last_sync_at: number | null
    total_rows_synced: number
    status: 'idle' | 'syncing' | 'synced' | 'error'
    last_error: string | null
}

export interface TableSyncResult {
    table: string
    rowsSynced: number
    newCursor: string | null
    durationMs: number
    error?: string
}

function escapeIdentifier(id: string): string {
    return `"${id.replace(/"/g, '""')}"`
}

function escapeTableOrSchemaName(name: string): string {
    if (name.includes('.')) {
        const parts = name.split('.')
        return parts.map(escapeIdentifier).join('.')
    }
    return escapeIdentifier(name)
}

function stripSchema(name: string): string {
    if (name.includes('.')) {
        const parts = name.split('.')
        return parts[parts.length - 1]
    }
    return name
}

const SQL_QUERIES = {
    CREATE_STATE_TABLE: `
        CREATE TABLE IF NOT EXISTS _starbase_replication_state (
            table_name TEXT PRIMARY KEY,
            cursor_value TEXT,
            last_sync_at INTEGER,
            total_rows_synced INTEGER DEFAULT 0,
            status TEXT DEFAULT 'idle',
            last_error TEXT
        )
    `,
    GET_TABLE_STATE: `
        SELECT table_name, cursor_value, last_sync_at, total_rows_synced, status, last_error
        FROM _starbase_replication_state
        WHERE table_name = ?
    `,
    GET_ALL_STATES: `
        SELECT table_name, cursor_value, last_sync_at, total_rows_synced, status, last_error
        FROM _starbase_replication_state
    `,
    UPSERT_TABLE_STATE: `
        INSERT OR REPLACE INTO _starbase_replication_state (
            table_name, cursor_value, last_sync_at, total_rows_synced, status, last_error
        ) VALUES (?, ?, ?, ?, ?, ?)
    `,
    RESET_TABLE_STATE: `
        UPDATE _starbase_replication_state
        SET cursor_value = NULL, last_sync_at = NULL, total_rows_synced = 0, status = 'idle', last_error = NULL
        WHERE table_name = ?
    `,
    RESET_ALL_STATES: `
        UPDATE _starbase_replication_state
        SET cursor_value = NULL, last_sync_at = NULL, total_rows_synced = 0, status = 'idle', last_error = NULL
    `,
}

export class ReplicationPlugin extends StarbasePlugin {
    public prefix: string = '/replication'
    public override pathPrefix: string = '/replication'
    private dataSource?: DataSource
    private tableConfigs: Map<string, TableReplicationConfig> = new Map()
    private defaultIntervalSeconds: number
    private autoCreateTable: boolean
    private syncingTables: Set<string> = new Set()
    private isInitialized: boolean = false

    constructor(options: ReplicationPluginOptions = {}) {
        super('starbasedb:replication', {
            requiresAuth: options.requiresAuth ?? true,
        })
        this.defaultIntervalSeconds = options.defaultIntervalSeconds ?? 60
        this.autoCreateTable = options.autoCreateTable ?? true

        if (options.tables) {
            options.tables.forEach((t) => this.configureTable(t))
        }
    }

    public setDataSource(dataSource: DataSource): void {
        this.dataSource = dataSource
    }

    public configureTable(config: TableReplicationConfig): void {
        if (
            !config ||
            !config.name ||
            typeof config.name !== 'string' ||
            !config.name.trim()
        ) {
            throw new Error(
                'Table name is required for replication configuration'
            )
        }
        const cleanName = config.name.trim()
        const effectiveConfig: TableReplicationConfig = {
            batchSize: 500,
            primaryKey: 'id',
            syncIntervalSeconds: this.defaultIntervalSeconds,
            targetTable: config.targetTable ?? stripSchema(cleanName),
            ...config,
            name: cleanName,
        }
        this.tableConfigs.set(cleanName, effectiveConfig)
    }

    public getTableConfigs(): TableReplicationConfig[] {
        return Array.from(this.tableConfigs.values())
    }

    public getTableConfig(name: string): TableReplicationConfig | undefined {
        return this.tableConfigs.get(name)
    }

    override async register(app: StarbaseApp): Promise<void> {
        // Middleware to attach dataSource and ensure schema state table exists
        app.use(async (c, next) => {
            const ds = c?.get?.('dataSource')
            if (ds) {
                this.dataSource = ds
                if (!this.isInitialized) {
                    await this.init()
                }
            }
            await next()
        })

        // GET /replication/status
        app.get(`${this.pathPrefix}/status`, async () => {
            try {
                const status = await this.getStatus()
                return createResponse(status, undefined, 200)
            } catch (err: any) {
                return createResponse(
                    null,
                    err?.message ?? 'Failed to get status',
                    500
                )
            }
        })

        // POST /replication/sync
        app.post(`${this.pathPrefix}/sync`, async (c) => {
            try {
                let body: { table?: string; forceFull?: boolean } = {}
                try {
                    body = (await c.req.json()) ?? {}
                } catch {
                    // Empty or missing json body is acceptable
                }

                if (body.table) {
                    const result = await this.syncTable(
                        body.table,
                        body.forceFull ?? false
                    )
                    return createResponse(result, undefined, 200)
                }

                const results = await this.syncAll(body.forceFull ?? false)
                return createResponse(results, undefined, 200)
            } catch (err: any) {
                return createResponse(
                    null,
                    err?.message ?? 'Replication sync failed',
                    500
                )
            }
        })

        // POST /replication/configure
        app.post(`${this.pathPrefix}/configure`, async (c) => {
            try {
                const body = (await c.req.json()) as TableReplicationConfig
                if (!body || !body.name) {
                    return createResponse(
                        null,
                        'Table name is required for replication configuration',
                        400
                    )
                }
                this.configureTable(body)
                return createResponse(
                    { success: true, table: body.name },
                    undefined,
                    200
                )
            } catch (err: any) {
                return createResponse(
                    null,
                    err?.message ?? 'Configuration failed',
                    400
                )
            }
        })

        // POST /replication/reset
        app.post(`${this.pathPrefix}/reset`, async (c) => {
            try {
                let body: { table?: string } = {}
                try {
                    body = (await c.req.json()) ?? {}
                } catch {
                    // Empty json body is fine
                }
                await this.resetState(body.table)
                return createResponse(
                    { success: true, table: body.table ?? 'all' },
                    undefined,
                    200
                )
            } catch (err: any) {
                return createResponse(null, err?.message ?? 'Reset failed', 500)
            }
        })
    }

    public async init(): Promise<void> {
        if (!this.dataSource) return
        try {
            await this.dataSource.rpc.executeQuery({
                sql: SQL_QUERIES.CREATE_STATE_TABLE,
                params: [],
            })
            this.isInitialized = true
        } catch (error) {
            console.error(
                'Error initializing ReplicationPlugin state table:',
                error
            )
        }
    }

    public async getStatus(): Promise<{
        tables: TableSyncState[]
        configuredCount: number
        syncingTables: string[]
    }> {
        if (!this.dataSource) {
            throw new Error(
                'ReplicationPlugin not initialized: DataSource is missing'
            )
        }

        const rows = (await this.dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.GET_ALL_STATES,
            params: [],
        })) as unknown as TableSyncState[]

        return {
            tables: Array.isArray(rows) ? rows : [],
            configuredCount: this.tableConfigs.size,
            syncingTables: Array.from(this.syncingTables),
        }
    }

    public async resetState(tableName?: string): Promise<void> {
        if (!this.dataSource) {
            throw new Error(
                'ReplicationPlugin not initialized: DataSource is missing'
            )
        }

        if (tableName) {
            await this.dataSource.rpc.executeQuery({
                sql: SQL_QUERIES.RESET_TABLE_STATE,
                params: [tableName],
            })
        } else {
            await this.dataSource.rpc.executeQuery({
                sql: SQL_QUERIES.RESET_ALL_STATES,
                params: [],
            })
        }
    }

    public async syncAll(
        forceFull: boolean = false
    ): Promise<TableSyncResult[]> {
        const results: TableSyncResult[] = []
        for (const tableName of this.tableConfigs.keys()) {
            const res = await this.syncTable(tableName, forceFull)
            results.push(res)
        }
        return results
    }

    public async handleCron(): Promise<TableSyncResult[]> {
        return await this.syncAll(false)
    }

    public async syncTable(
        tableName: string,
        forceFull: boolean = false
    ): Promise<TableSyncResult> {
        const startTime = Date.now()
        const config = this.tableConfigs.get(tableName)
        if (!config) {
            throw new Error(
                `Table '${tableName}' is not configured for replication`
            )
        }

        if (!this.dataSource) {
            throw new Error(
                'ReplicationPlugin not initialized: DataSource is missing'
            )
        }

        if (this.syncingTables.has(tableName)) {
            return {
                table: tableName,
                rowsSynced: 0,
                newCursor: null,
                durationMs: 0,
                error: `Replication for table '${tableName}' is already in progress`,
            }
        }

        this.syncingTables.add(tableName)

        try {
            // Retrieve current replication cursor state
            const stateResult = (await this.dataSource.rpc.executeQuery({
                sql: SQL_QUERIES.GET_TABLE_STATE,
                params: [tableName],
            })) as unknown as TableSyncState[]

            const currentState =
                Array.isArray(stateResult) && stateResult.length > 0
                    ? stateResult[0]
                    : null
            const previousCursor = forceFull
                ? null
                : (currentState?.cursor_value ?? null)
            const previousTotal = forceFull
                ? 0
                : (currentState?.total_rows_synced ?? 0)

            // Construct pull query for external database
            const targetTable = config.targetTable ?? stripSchema(config.name)
            const batchSize = Math.max(
                1,
                Math.min(5000, config.batchSize ?? 500)
            )
            const columnsStr =
                config.columns && config.columns.length > 0
                    ? config.columns.map(escapeIdentifier).join(', ')
                    : '*'

            const sourceTableEscaped = escapeTableOrSchemaName(config.name)
            let pullSql = `SELECT ${columnsStr} FROM ${sourceTableEscaped}`
            const whereClauses: string[] = []
            const queryParams: unknown[] = []

            if (config.whereClause) {
                whereClauses.push(`(${config.whereClause})`)
            }

            if (config.cursorColumn && previousCursor !== null) {
                whereClauses.push(
                    `${escapeIdentifier(config.cursorColumn)} > ?`
                )
                queryParams.push(previousCursor)
            }

            if (whereClauses.length > 0) {
                pullSql += ` WHERE ${whereClauses.join(' AND ')}`
            }

            if (config.cursorColumn) {
                pullSql += ` ORDER BY ${escapeIdentifier(config.cursorColumn)} ASC`
            }

            pullSql += ` LIMIT ${batchSize}`

            // Fetch data from external database source
            let externalRows: Record<string, any>[] = []
            if (this.dataSource.external) {
                const extResult = await this.dataSource.external.executeQuery({
                    sql: pullSql,
                    params: queryParams,
                })
                externalRows = Array.isArray(extResult)
                    ? (extResult as Record<string, any>[])
                    : []
            } else {
                // Fallback: internal RPC query for testing environment
                const extResult = (await this.dataSource.rpc.executeQuery({
                    sql: pullSql,
                    params: queryParams,
                })) as unknown as Record<string, any>[]
                externalRows = Array.isArray(extResult) ? extResult : []
            }

            if (!externalRows || externalRows.length === 0) {
                // No new records to sync
                await this.dataSource.rpc.executeQuery({
                    sql: SQL_QUERIES.UPSERT_TABLE_STATE,
                    params: [
                        tableName,
                        previousCursor,
                        Date.now(),
                        previousTotal,
                        'synced',
                        null,
                    ],
                })
                return {
                    table: tableName,
                    rowsSynced: 0,
                    newCursor: previousCursor,
                    durationMs: Date.now() - startTime,
                }
            }

            // Auto-create destination table in SQLite if enabled
            if (this.autoCreateTable && externalRows.length > 0) {
                await this.ensureLocalTable(
                    targetTable,
                    externalRows[0],
                    config.primaryKey ?? 'id'
                )
            }

            // Batch insert or replace into local SQLite database
            let newCursor: string | null = previousCursor
            const rowKeys = Object.keys(externalRows[0])
            const quotedCols = rowKeys.map(escapeIdentifier).join(', ')
            const placeholders = rowKeys.map(() => '?').join(', ')
            const insertSql = `INSERT OR REPLACE INTO ${escapeIdentifier(targetTable)} (${quotedCols}) VALUES (${placeholders})`

            for (const row of externalRows) {
                const values = rowKeys.map((k) =>
                    row[k] === undefined ? null : row[k]
                )
                await this.dataSource.rpc.executeQuery({
                    sql: insertSql,
                    params: values,
                })

                if (
                    config.cursorColumn &&
                    row[config.cursorColumn] !== undefined &&
                    row[config.cursorColumn] !== null
                ) {
                    newCursor = String(row[config.cursorColumn])
                }
            }

            const totalSynced = previousTotal + externalRows.length
            await this.dataSource.rpc.executeQuery({
                sql: SQL_QUERIES.UPSERT_TABLE_STATE,
                params: [
                    tableName,
                    newCursor,
                    Date.now(),
                    totalSynced,
                    'synced',
                    null,
                ],
            })

            return {
                table: tableName,
                rowsSynced: externalRows.length,
                newCursor,
                durationMs: Date.now() - startTime,
            }
        } catch (error: any) {
            const errorMsg = error?.message ?? String(error)
            console.error(`Replication error on table '${tableName}':`, error)

            if (this.dataSource) {
                try {
                    await this.dataSource.rpc.executeQuery({
                        sql: SQL_QUERIES.UPSERT_TABLE_STATE,
                        params: [
                            tableName,
                            null,
                            Date.now(),
                            0,
                            'error',
                            errorMsg,
                        ],
                    })
                } catch {
                    // Ignore secondary error while reporting state
                }
            }

            return {
                table: tableName,
                rowsSynced: 0,
                newCursor: null,
                durationMs: Date.now() - startTime,
                error: errorMsg,
            }
        } finally {
            this.syncingTables.delete(tableName)
        }
    }

    private async ensureLocalTable(
        targetTable: string,
        sampleRow: Record<string, any>,
        primaryKey: string
    ): Promise<void> {
        if (!this.dataSource) return

        const columnDefs = Object.entries(sampleRow).map(([col, val]) => {
            let colType = 'TEXT'
            if (typeof val === 'number') {
                colType = Number.isInteger(val) ? 'INTEGER' : 'REAL'
            } else if (typeof val === 'boolean') {
                colType = 'INTEGER'
            }
            const escapedCol = escapeIdentifier(col)
            if (col === primaryKey) {
                return `${escapedCol} ${colType} PRIMARY KEY`
            }
            return `${escapedCol} ${colType}`
        })

        const escapedTable = escapeIdentifier(targetTable)
        const createSql = `CREATE TABLE IF NOT EXISTS ${escapedTable} (${columnDefs.join(', ')})`
        await this.dataSource.rpc.executeQuery({
            sql: createSql,
            params: [],
        })
    }
}
