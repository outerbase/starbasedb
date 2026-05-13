import { StarbaseApp, StarbaseDBConfiguration } from '../../src/handler'
import { StarbasePlugin } from '../../src/plugin'
import { DataSource, QueryResult } from '../../src/types'
import { createResponse } from '../../src/utils'

/**
 * Configuration for a single table replication rule.
 */
export interface ReplicateTableConfig {
    /** Table name in the external source to pull from */
    table: string
    /** Optional column used for incremental polling (e.g. "id" or "created_at") */
    cursorColumn?: string
    /** Optional list of columns to select; defaults to all (*) */
    columns?: string[]
}

/**
 * Options passed to the ReplicatePlugin constructor.
 */
export interface ReplicatePluginOptions {
    /**
     * Tables to replicate. If omitted, all tables from the external source
     * are replicated (full-table, no incremental cursor).
     */
    tables?: ReplicateTableConfig[]
    /**
     * How many rows to fetch per batch to avoid memory pressure.
     * Defaults to 500.
     */
    batchSize?: number
}

const META_TABLE = 'tmp_replicate_meta'

const SQL = {
    CREATE_META: `
        CREATE TABLE IF NOT EXISTS ${META_TABLE} (
            table_name  TEXT NOT NULL PRIMARY KEY,
            cursor_col  TEXT,
            last_cursor TEXT
        )
    `,
    GET_META: `SELECT cursor_col, last_cursor FROM ${META_TABLE} WHERE table_name = ?`,
    UPSERT_META: `
        INSERT INTO ${META_TABLE} (table_name, cursor_col, last_cursor)
        VALUES (?, ?, ?)
        ON CONFLICT(table_name) DO UPDATE SET
            cursor_col  = excluded.cursor_col,
            last_cursor = excluded.last_cursor
    `,
}

export class ReplicatePlugin extends StarbasePlugin {
    public pathPrefix: string = '/replicate'
    private dataSource?: DataSource
    private config?: StarbaseDBConfiguration
    private tables: ReplicateTableConfig[]
    private batchSize: number

    constructor(opts: ReplicatePluginOptions = {}) {
        super('starbasedb:replicate', { requiresAuth: true })
        this.tables = opts.tables ?? []
        this.batchSize = opts.batchSize ?? 500
    }

    override async register(app: StarbaseApp) {
        // Capture dataSource + config from middleware context
        app.use(async (c, next) => {
            this.dataSource = c.get('dataSource')
            this.config = c.get('config')
            await next()
        })

        // POST /replicate/run — trigger a manual replication cycle
        app.post(`${this.pathPrefix}/run`, async (c) => {
            if (this.config?.role !== 'admin') {
                return createResponse(undefined, 'Unauthorized', 401)
            }
            try {
                const result = await this.runReplication()
                return createResponse(result, undefined, 200)
            } catch (err: any) {
                return createResponse(undefined, err?.message ?? 'Replication failed', 500)
            }
        })

        // GET /replicate/status — show last cursor values per table
        app.get(`${this.pathPrefix}/status`, async (c) => {
            if (this.config?.role !== 'admin') {
                return createResponse(undefined, 'Unauthorized', 401)
            }
            try {
                await this.ensureMetaTable()
                const rows = await this.internalQuery(
                    `SELECT table_name, cursor_col, last_cursor FROM ${META_TABLE}`,
                    []
                )
                return createResponse(rows, undefined, 200)
            } catch (err: any) {
                return createResponse(undefined, err?.message ?? 'Status query failed', 500)
            }
        })
    }

    /**
     * Run a full replication cycle. Called from the HTTP route or externally
     * (e.g. from a CronPlugin callback).
     */
    public async runReplication(): Promise<{ table: string; rowsInserted: number }[]> {
        if (!this.dataSource) throw new Error('dataSource not available')
        if (!this.dataSource.external) throw new Error('No external data source configured')

        await this.ensureMetaTable()

        // Discover tables if none were explicitly configured
        const tablesToReplicate = this.tables.length > 0
            ? this.tables
            : await this.discoverTables()

        const summary: { table: string; rowsInserted: number }[] = []

        for (const tableConfig of tablesToReplicate) {
            const count = await this.replicateTable(tableConfig)
            summary.push({ table: tableConfig.table, rowsInserted: count })
        }

        return summary
    }

    // -------------------------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------------------------

    private async ensureMetaTable(): Promise<void> {
        await this.internalQuery(SQL.CREATE_META, [])
    }

    /**
     * Discover all user tables from the external source by querying
     * information_schema (Postgres/MySQL) or sqlite_master (SQLite).
     */
    private async discoverTables(): Promise<ReplicateTableConfig[]> {
        const ext = this.dataSource!.external!
        let sql: string

        if ('dialect' in ext && ext.dialect === 'sqlite') {
            sql = `SELECT name AS table_name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`
        } else {
            // Postgres / MySQL
            const schema = ('defaultSchema' in ext && ext.defaultSchema) ? ext.defaultSchema : 'public'
            sql = `SELECT table_name FROM information_schema.tables WHERE table_schema = '${schema}' AND table_type = 'BASE TABLE'`
        }

        const rows = await this.externalQuery(sql, [])
        return (rows as QueryResult[]).map((r) => ({
            table: String(r['table_name'] ?? r['name']),
        }))
    }

    private async replicateTable(tableConfig: ReplicateTableConfig): Promise<number> {
        const { table, cursorColumn, columns } = tableConfig
        const colList = columns && columns.length > 0 ? columns.join(', ') : '*'

        // Load last cursor from meta
        const metaRows = await this.internalQuery(SQL.GET_META, [table]) as QueryResult[]
        const meta = metaRows[0]
        const lastCursor = meta?.last_cursor ?? null
        const activeCursorCol = cursorColumn ?? (meta?.cursor_col ? String(meta.cursor_col) : null)

        let offset = 0
        let totalInserted = 0

        while (true) {
            // Build SELECT with optional incremental filter
            let fetchSQL = `SELECT ${colList} FROM ${table}`
            const fetchParams: unknown[] = []

            if (activeCursorCol && lastCursor !== null) {
                fetchSQL += ` WHERE ${activeCursorCol} > ?`
                fetchParams.push(lastCursor)
            }

            if (activeCursorCol) {
                fetchSQL += ` ORDER BY ${activeCursorCol} ASC`
            }

            fetchSQL += ` LIMIT ${this.batchSize} OFFSET ${offset}`

            const rows = await this.externalQuery(fetchSQL, fetchParams) as QueryResult[]
            if (!rows || rows.length === 0) break

            // Ensure destination table exists (CREATE TABLE IF NOT EXISTS mirroring source schema)
            await this.ensureDestTable(table, rows[0])

            // Upsert rows into internal SQLite
            for (const row of rows) {
                await this.upsertRow(table, row)
            }

            totalInserted += rows.length

            // Update cursor after each batch
            if (activeCursorCol) {
                const lastRow = rows[rows.length - 1]
                const newCursor = String(lastRow[activeCursorCol] ?? '')
                await this.internalQuery(SQL.UPSERT_META, [table, activeCursorCol, newCursor])
            }

            if (rows.length < this.batchSize) break
            offset += this.batchSize
        }

        // If no cursor column, record a full-sync marker
        if (!activeCursorCol) {
            await this.internalQuery(SQL.UPSERT_META, [table, null, new Date().toISOString()])
        }

        return totalInserted
    }

    /**
     * Create the destination table in internal SQLite if it doesn't exist,
     * inferring column types from the first row of data.
     */
    private async ensureDestTable(table: string, sampleRow: QueryResult): Promise<void> {
        const cols = Object.keys(sampleRow)
            .map((col) => {
                const val = sampleRow[col]
                let type = 'TEXT'
                if (typeof val === 'number') type = Number.isInteger(val) ? 'INTEGER' : 'REAL'
                else if (typeof val === 'boolean') type = 'INTEGER'
                return `"${col}" ${type}`
            })
            .join(', ')

        const ddl = `CREATE TABLE IF NOT EXISTS "${table}" (${cols})`
        await this.internalQuery(ddl, [])
    }

    /**
     * Insert or replace a single row into the internal SQLite table.
     */
    private async upsertRow(table: string, row: QueryResult): Promise<void> {
        const cols = Object.keys(row)
        const placeholders = cols.map(() => '?').join(', ')
        const values = cols.map((c) => {
            const v = row[c]
            if (typeof v === 'boolean') return v ? 1 : 0
            if (v === null || v === undefined) return null
            return v
        })
        const sql = `INSERT OR REPLACE INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${placeholders})`
        await this.internalQuery(sql, values)
    }

    /** Execute a query against the internal Durable Object SQLite */
    private async internalQuery(sql: string, params: unknown[]): Promise<unknown[]> {
        const ds = this.dataSource!
        const result = await ds.rpc.executeQuery({ sql, params, isRaw: false })
        return (result as unknown[]) ?? []
    }

    /** Execute a query against the external data source */
    private async externalQuery(sql: string, params: unknown[]): Promise<unknown[]> {
        const ds = this.dataSource!
        // Temporarily switch source to external for this query
        const externalDs: DataSource = { ...ds, source: 'external' }
        const { executeQuery } = await import('../../src/operation')
        const result = await executeQuery({
            sql,
            params: params as unknown[],
            isRaw: false,
            dataSource: externalDs,
            config: this.config!,
        })
        return (result as unknown[]) ?? []
    }
}
