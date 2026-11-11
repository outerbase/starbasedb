import { StarbaseApp, StarbaseDBConfiguration } from '../../src/handler'
import { StarbasePlugin } from '../../src/plugin'
import { DataSource } from '../../src/types'
import { createResponse } from '../../src/utils'

export interface ReplicationTableConfig {
    table: string
    primaryKey?: string
    cursorColumn?: string
    batchSize?: number
}

export interface ExternalPullSource {
    fetchRows: (
        table: string,
        options: { cursor?: string | number | null; limit: number; offset: number }
    ) => Promise<Record<string, any>[]>
}

export interface ReplicationPluginOptions {
    tables: (string | ReplicationTableConfig)[]
    externalSource?: ExternalPullSource
    externalEndpoint?: string
    externalApiKey?: string
    batchSize?: number
    requiresAuth?: boolean
}

export interface TableSyncReport {
    table: string
    rowsSynced: number
    lastCursor: string | number | null
    status: 'synced' | 'failed'
    error?: string
}

function quoteIdent(name: string): string {
    return `"${String(name).replace(/"/g, '""')}"`
}

function inferSqliteType(val: unknown): string {
    if (typeof val === 'number') {
        return Number.isInteger(val) ? 'INTEGER' : 'REAL'
    }
    if (typeof val === 'boolean') {
        return 'INTEGER'
    }
    if (val instanceof Uint8Array) {
        return 'BLOB'
    }
    return 'TEXT'
}

function normalizeSqlParam(val: unknown): any {
    if (val === undefined) return null
    if (typeof val === 'boolean') return val ? 1 : 0
    if (val !== null && typeof val === 'object' && !(val instanceof Uint8Array)) {
        return JSON.stringify(val)
    }
    return val
}

export class ReplicationPlugin extends StarbasePlugin {
    public prefix: string = '/replication'
    private config?: StarbaseDBConfiguration
    private dataSource?: DataSource
    private options: ReplicationPluginOptions
    private lastSyncReports: Record<string, TableSyncReport> = {}

    constructor(options: ReplicationPluginOptions) {
        super('starbasedb:replication', {
            requiresAuth: options.requiresAuth ?? true,
        })
        this.options = {
            batchSize: 500,
            ...options,
        }
    }

    private async executeInternal(sql: string, params: any[] = []): Promise<any[]> {
        if (!this.dataSource?.rpc) {
            throw new Error('Internal DataSource RPC is not available')
        }
        const rpc: any = this.dataSource.rpc
        if (typeof rpc.executeQuery === 'function') {
            const res = await rpc.executeQuery(sql, params)
            return Array.isArray(res) ? res : (res?.rows ?? res?.results ?? [])
        }
        if (typeof rpc.executeTransaction === 'function') {
            const res = await rpc.executeTransaction([{ sql, params }])
            return Array.isArray(res?.[0]) ? res[0] : (res ?? [])
        }
        throw new Error('Unsupported DataSource RPC interface')
    }

    private async initMetadataTable(): Promise<void> {
        await this.executeInternal(`
            CREATE TABLE IF NOT EXISTS _starbase_replication_state (
                table_name TEXT PRIMARY KEY,
                last_cursor TEXT,
                rows_synced INTEGER DEFAULT 0,
                updated_at TEXT
            )
        `)
    }

    private async getSavedCursor(table: string): Promise<string | null> {
        const rows = await this.executeInternal(
            `SELECT last_cursor FROM _starbase_replication_state WHERE table_name = ?`,
            [table]
        )
        return rows.length > 0 ? (rows[0].last_cursor ?? null) : null
    }

    private async saveCursor(table: string, cursor: string | number | null, count: number): Promise<void> {
        await this.executeInternal(
            `INSERT OR REPLACE INTO _starbase_replication_state (table_name, last_cursor, rows_synced, updated_at)
             VALUES (?, ?, ?, ?)`,
            [table, cursor !== null && cursor !== undefined ? String(cursor) : null, count, new Date().toISOString()]
        )
    }

    private async ensureTableSchema(
        table: string,
        sampleRow: Record<string, any>,
        primaryKey: string = 'id'
    ): Promise<void> {
        const cols = Object.keys(sampleRow)
        if (cols.length === 0) return

        const colDefs = cols.map((col) => {
            const sqlType = inferSqliteType(sampleRow[col])
            const pkClause = col === primaryKey ? ' PRIMARY KEY' : ''
            return `${quoteIdent(col)} ${sqlType}${pkClause}`
        })

        const createSql = `CREATE TABLE IF NOT EXISTS ${quoteIdent(table)} (${colDefs.join(', ')})`
        await this.executeInternal(createSql)
    }

    private async pullExternalBatch(
        table: string,
        opts: { cursor?: string | number | null; limit: number; offset: number }
    ): Promise<Record<string, any>[]> {
        if (this.options.externalSource) {
            return this.options.externalSource.fetchRows(table, opts)
        }
        if (this.options.externalEndpoint) {
            const url = new URL(this.options.externalEndpoint)
            url.searchParams.set('table', table)
            url.searchParams.set('limit', String(opts.limit))
            url.searchParams.set('offset', String(opts.offset))
            if (opts.cursor !== null && opts.cursor !== undefined) {
                url.searchParams.set('cursor', String(opts.cursor))
            }
            const headers: Record<string, string> = { 'Content-Type': 'application/json' }
            if (this.options.externalApiKey) {
                headers['Authorization'] = `Bearer ${this.options.externalApiKey}`
                headers['apikey'] = this.options.externalApiKey
            }
            const res = await fetch(url.toString(), { headers })
            if (!res.ok) {
                throw new Error(`External source HTTP error ${res.status}`)
            }
            const body: any = await res.json()
            return Array.isArray(body) ? body : (body?.data ?? body?.rows ?? [])
        }
        throw new Error('No externalSource or externalEndpoint configured for ReplicationPlugin')
    }

    public async syncTable(tableCfg: string | ReplicationTableConfig): Promise<TableSyncReport> {
        const cfg: ReplicationTableConfig =
            typeof tableCfg === 'string' ? { table: tableCfg } : tableCfg
        const table = cfg.table
        const primaryKey = cfg.primaryKey ?? 'id'
        const cursorCol = cfg.cursorColumn
        const batchSize = cfg.batchSize ?? this.options.batchSize ?? 500

        try {
            await this.initMetadataTable()
            let cursor: string | number | null = cursorCol ? await this.getSavedCursor(table) : null
            let offset = 0
            let totalSynced = 0
            let schemaInitialized = false

            while (true) {
                const rows = await this.pullExternalBatch(table, {
                    cursor,
                    limit: batchSize,
                    offset,
                })

                if (!rows || rows.length === 0) {
                    break
                }

                if (!schemaInitialized) {
                    await this.ensureTableSchema(table, rows[0], primaryKey)
                    schemaInitialized = true
                }

                const columns = Object.keys(rows[0])
                const quotedCols = columns.map(quoteIdent).join(', ')
                const placeholders = columns.map(() => '?').join(', ')
                const upsertSql = `INSERT OR REPLACE INTO ${quoteIdent(table)} (${quotedCols}) VALUES (${placeholders})`

                for (const row of rows) {
                    const values = columns.map((c) => normalizeSqlParam(row[c]))
                    await this.executeInternal(upsertSql, values)
                    if (cursorCol && row[cursorCol] !== undefined && row[cursorCol] !== null) {
                        cursor = row[cursorCol]
                    }
                }

                totalSynced += rows.length
                if (rows.length < batchSize) {
                    break
                }
                offset += rows.length
            }

            await this.saveCursor(table, cursor, totalSynced)
            const report: TableSyncReport = {
                table,
                rowsSynced: totalSynced,
                lastCursor: cursor,
                status: 'synced',
            }
            this.lastSyncReports[table] = report
            return report
        } catch (err: any) {
            const report: TableSyncReport = {
                table,
                rowsSynced: 0,
                lastCursor: null,
                status: 'failed',
                error: err instanceof Error ? err.message : String(err),
            }
            this.lastSyncReports[table] = report
            return report
        }
    }

    public async syncAll(targetTables?: string[]): Promise<TableSyncReport[]> {
        const selected = targetTables?.length
            ? this.options.tables.filter((t) =>
                  targetTables.includes(typeof t === 'string' ? t : t.table)
              )
            : this.options.tables

        const reports: TableSyncReport[] = []
        for (const t of selected) {
            reports.push(await this.syncTable(t))
        }
        return reports
    }

    override async register(app: StarbaseApp) {
        app.use(async (c, next) => {
            this.config = c?.get('config')
            this.dataSource = c?.get('dataSource')
            await next()
        })

        app.post(`${this.prefix}/sync`, async (c) => {
            if (this.options.requiresAuth !== false && this.config?.role !== 'admin') {
                return createResponse(undefined, 'Unauthorized request', 401)
            }

            let body: { tables?: string[] } = {}
            try {
                body = await c.req.json()
            } catch {
                body = {}
            }

            const reports = await this.syncAll(body.tables)
            const hasFailure = reports.some((r) => r.status === 'failed')
            return createResponse(
                { reports, syncedAt: new Date().toISOString() },
                hasFailure ? 'One or more tables failed to replicate' : undefined,
                hasFailure ? 207 : 200
            )
        })

        app.get(`${this.prefix}/status`, async (c) => {
            if (this.options.requiresAuth !== false && this.config?.role !== 'admin') {
                return createResponse(undefined, 'Unauthorized request', 401)
            }
            return createResponse({ tables: this.lastSyncReports }, undefined, 200)
        })
    }
}
