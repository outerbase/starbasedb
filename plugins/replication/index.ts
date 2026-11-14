import { StarbaseApp, StarbaseDBConfiguration } from '../../src/handler'
import { executeExternalQuery } from '../../src/operation'
import { StarbasePlugin } from '../../src/plugin'
import { DataSource } from '../../src/types'
import { createResponse } from '../../src/utils'

const SAFE_IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/

const SQL_QUERIES = {
    CREATE_META_TABLE: `
        CREATE TABLE IF NOT EXISTS _starbase_replication_meta (
            table_name TEXT NOT NULL UNIQUE PRIMARY KEY,
            rows_synced INTEGER NOT NULL DEFAULT 0,
            last_synced_at INTEGER NOT NULL,
            status TEXT NOT NULL
        )
    `,
    UPSERT_META: `
        INSERT OR REPLACE INTO _starbase_replication_meta (table_name, rows_synced, last_synced_at, status)
        VALUES (?, ?, ?, ?)
    `,
    GET_META: `
        SELECT table_name, rows_synced, last_synced_at, status
        FROM _starbase_replication_meta
        ORDER BY table_name ASC
    `,
}

export interface ReplicationPluginOptions {
    /** List of external table names to replicate into internal SQLite. */
    tables?: string[]
    /** Minimum interval (in seconds) between automatic syncs when autoSyncOnQuery is enabled. */
    intervalSeconds?: number
    /** When true, automatically checks and runs replication before queries once intervalSeconds elapses. */
    autoSyncOnQuery?: boolean
    /** Conflict handling when inserting replicated rows into internal SQLite. */
    conflictStrategy?: 'replace' | 'ignore'
    /** Number of rows to insert per internal transaction batch. */
    batchSize?: number
}

export interface TableSyncResult {
    table: string
    rowsSynced: number
    syncedAt: number
    status: 'synced' | 'empty' | 'error'
    error?: string
}

function assertSafeIdentifier(name: string): string {
    if (!SAFE_IDENTIFIER_RE.test(name)) {
        throw new Error(`Invalid SQL identifier: ${name}`)
    }
    return name
}

function inferSqliteColumnType(value: unknown): string {
    if (typeof value === 'number') {
        return Number.isInteger(value) ? 'INTEGER' : 'REAL'
    }
    if (typeof value === 'boolean') {
        return 'INTEGER'
    }
    if (value instanceof Uint8Array) {
        return 'BLOB'
    }
    return 'TEXT'
}

function normalizeSqliteValue(value: unknown): unknown {
    if (value === undefined) return null
    if (typeof value === 'boolean') return value ? 1 : 0
    if (
        value !== null &&
        typeof value === 'object' &&
        !(value instanceof Uint8Array)
    ) {
        return JSON.stringify(value)
    }
    return value
}

export class ReplicationPlugin extends StarbasePlugin {
    public pathPrefix: string = '/replication'
    public tables: string[]
    public intervalSeconds: number
    public autoSyncOnQuery: boolean
    public conflictStrategy: 'replace' | 'ignore'
    public batchSize: number

    private dataSource?: DataSource
    private config?: StarbaseDBConfiguration
    private lastAutoSyncAt: number = 0
    private isSyncing: boolean = false

    constructor(opts: ReplicationPluginOptions = {}) {
        super('starbasedb:replication', { requiresAuth: true })
        this.tables = opts.tables ?? []
        this.intervalSeconds = opts.intervalSeconds ?? 60
        this.autoSyncOnQuery = opts.autoSyncOnQuery ?? false
        this.conflictStrategy = opts.conflictStrategy ?? 'replace'
        this.batchSize = Math.max(1, opts.batchSize ?? 100)
    }

    override async register(app: StarbaseApp): Promise<void> {
        app.use(async (c, next) => {
            this.dataSource = c?.get('dataSource')
            this.config = c?.get('config')
            await next()
        })

        app.get(`${this.pathPrefix}/status`, async (c) => {
            const config = c?.get('config') ?? this.config
            const dataSource = c?.get('dataSource') ?? this.dataSource

            if (config?.role !== 'admin') {
                return createResponse(
                    { error: 'Unauthorized request' },
                    undefined,
                    401
                )
            }

            if (!dataSource?.rpc) {
                return createResponse(
                    { error: 'Internal data source is not initialized' },
                    undefined,
                    500
                )
            }

            await this.ensureMetaTable(dataSource)
            const metaRows = await dataSource.rpc.executeQuery({
                sql: SQL_QUERIES.GET_META,
                params: [],
            })

            return createResponse(
                {
                    configuredTables: this.tables,
                    intervalSeconds: this.intervalSeconds,
                    autoSyncOnQuery: this.autoSyncOnQuery,
                    lastAutoSyncAt: this.lastAutoSyncAt || null,
                    tables: metaRows,
                },
                undefined,
                200
            )
        })

        app.post(`${this.pathPrefix}/sync`, async (c) => {
            const config = c?.get('config') ?? this.config
            const dataSource = c?.get('dataSource') ?? this.dataSource

            if (config?.role !== 'admin') {
                return createResponse(
                    { error: 'Unauthorized request' },
                    undefined,
                    401
                )
            }

            if (!dataSource || !config) {
                return createResponse(
                    { error: 'DataSource or configuration unavailable' },
                    undefined,
                    500
                )
            }

            let targetTables: string[] | undefined
            try {
                const body = (await c.req.json()) as { tables?: string[] }
                if (Array.isArray(body?.tables) && body.tables.length > 0) {
                    targetTables = body.tables
                }
            } catch {
                // Empty body is valid; falls back to configured tables
            }

            try {
                const results = await this.syncAll(
                    dataSource,
                    config,
                    targetTables
                )
                return createResponse({ success: true, results }, undefined, 200)
            } catch (error: any) {
                return createResponse(
                    {
                        success: false,
                        error: error?.message ?? 'Replication failed',
                    },
                    undefined,
                    400
                )
            }
        })
    }

    override async beforeQuery(opts: {
        sql: string
        params?: unknown[]
        dataSource?: DataSource
        config?: StarbaseDBConfiguration
    }): Promise<{ sql: string; params?: unknown[] }> {
        const now = Date.now()
        const elapsedMs = now - this.lastAutoSyncAt

        if (
            this.autoSyncOnQuery &&
            !this.isSyncing &&
            opts.dataSource?.external &&
            opts.config &&
            elapsedMs >= this.intervalSeconds * 1000
        ) {
            try {
                await this.syncAll(opts.dataSource, opts.config)
            } catch (error) {
                console.error('Auto-sync replication error:', error)
            }
        }

        return {
            sql: opts.sql,
            params: opts.params,
        }
    }

    public async ensureMetaTable(dataSource: DataSource): Promise<void> {
        await dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.CREATE_META_TABLE,
            params: [],
        })
    }

    public async discoverExternalTables(
        dataSource: DataSource,
        config: StarbaseDBConfiguration
    ): Promise<string[]> {
        if (!dataSource.external) {
            throw new Error('External connection not found.')
        }

        const dialect = dataSource.external.dialect
        let sql: string
        if (dialect === 'postgresql') {
            const schema = dataSource.external.defaultSchema ?? 'public'
            sql = `SELECT table_name FROM information_schema.tables WHERE table_schema = '${assertSafeIdentifier(schema)}' AND table_type = 'BASE TABLE'`
        } else if (dialect === 'mysql') {
            sql = `SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'`
        } else {
            sql = `SELECT name AS table_name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_starbase_%'`
        }

        const rows = (await executeExternalQuery({
            sql,
            params: [],
            dataSource,
            config,
        })) as Record<string, any>[]

        return (rows ?? [])
            .map((r) => r.table_name ?? r.TABLE_NAME ?? r.name)
            .filter((name): name is string => typeof name === 'string')
    }

    public async syncAll(
        dataSource: DataSource,
        config: StarbaseDBConfiguration,
        overrideTables?: string[]
    ): Promise<TableSyncResult[]> {
        if (!dataSource.external) {
            throw new Error('External connection not found.')
        }

        this.isSyncing = true
        try {
            await this.ensureMetaTable(dataSource)

            const tablesToSync =
                overrideTables && overrideTables.length > 0
                    ? overrideTables
                    : this.tables.length > 0
                      ? this.tables
                      : await this.discoverExternalTables(dataSource, config)

            const results: TableSyncResult[] = []
            for (const table of tablesToSync) {
                const res = await this.syncTable(table, dataSource, config)
                results.push(res)
            }

            this.lastAutoSyncAt = Date.now()
            return results
        } finally {
            this.isSyncing = false
        }
    }

    public async syncTable(
        tableName: string,
        dataSource: DataSource,
        config: StarbaseDBConfiguration
    ): Promise<TableSyncResult> {
        const safeTable = assertSafeIdentifier(tableName)
        const syncedAt = Date.now()

        try {
            const rows = (await executeExternalQuery({
                sql: `SELECT * FROM ${safeTable}`,
                params: [],
                dataSource,
                config,
            })) as Record<string, unknown>[]

            if (!Array.isArray(rows) || rows.length === 0) {
                await this.recordMeta(
                    dataSource,
                    safeTable,
                    0,
                    syncedAt,
                    'empty'
                )
                return {
                    table: safeTable,
                    rowsSynced: 0,
                    syncedAt,
                    status: 'empty',
                }
            }

            const columns = Object.keys(rows[0]).map(assertSafeIdentifier)
            const columnDefs = columns.map((col, idx) => {
                const sample = rows.find((r) => r[col] !== null && r[col] !== undefined)?.[col]
                const colType = inferSqliteColumnType(sample)
                return idx === 0 && col.toLowerCase() === 'id'
                    ? `${col} ${colType} PRIMARY KEY`
                    : `${col} ${colType}`
            })

            await dataSource.rpc.executeQuery({
                sql: `CREATE TABLE IF NOT EXISTS ${safeTable} (${columnDefs.join(', ')})`,
                params: [],
            })

            const verb =
                this.conflictStrategy === 'ignore'
                    ? 'INSERT OR IGNORE'
                    : 'INSERT OR REPLACE'
            const placeholders = columns.map(() => '?').join(', ')
            const insertSql = `${verb} INTO ${safeTable} (${columns.join(', ')}) VALUES (${placeholders})`

            for (let i = 0; i < rows.length; i += this.batchSize) {
                const chunk = rows.slice(i, i + this.batchSize)
                const queries = chunk.map((row) => ({
                    sql: insertSql,
                    params: columns.map((col) => normalizeSqliteValue(row[col])),
                }))

                const rpc = dataSource.rpc as any
                if (typeof rpc.executeTransaction === 'function') {
                    await rpc.executeTransaction(queries)
                } else {
                    for (const q of queries) {
                        await dataSource.rpc.executeQuery(q)
                    }
                }
            }

            await this.recordMeta(
                dataSource,
                safeTable,
                rows.length,
                syncedAt,
                'synced'
            )

            return {
                table: safeTable,
                rowsSynced: rows.length,
                syncedAt,
                status: 'synced',
            }
        } catch (error: any) {
            const msg = error?.message ?? 'Unknown error'
            await this.recordMeta(dataSource, safeTable, 0, syncedAt, 'error')
            return {
                table: safeTable,
                rowsSynced: 0,
                syncedAt,
                status: 'error',
                error: msg,
            }
        }
    }

    private async recordMeta(
        dataSource: DataSource,
        tableName: string,
        rowsSynced: number,
        syncedAt: number,
        status: string
    ): Promise<void> {
        await dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.UPSERT_META,
            params: [tableName, rowsSynced, syncedAt, status],
        })
    }
}
