import { StarbaseApp, StarbaseDBConfiguration } from '../../src/handler'
import { StarbasePlugin } from '../../src/plugin'
import { DataSource } from '../../src/types'

// ─── SQL DDL / DML ────────────────────────────────────────────────────────────

const SQL_QUERIES = {
    CREATE_METADATA_TABLE: `
        CREATE TABLE IF NOT EXISTS tmp_data_sync_metadata (
            table_name   TEXT    NOT NULL PRIMARY KEY,
            tracking_col TEXT    NOT NULL,
            last_value   TEXT,
            synced_at    TEXT    DEFAULT (datetime('now'))
        )
    `,
    GET_METADATA: `
        SELECT table_name, tracking_col, last_value
        FROM   tmp_data_sync_metadata
        WHERE  table_name = ?
    `,
    UPSERT_METADATA: `
        INSERT INTO tmp_data_sync_metadata (table_name, tracking_col, last_value, synced_at)
        VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT(table_name) DO UPDATE SET
            last_value = excluded.last_value,
            synced_at  = excluded.synced_at
    `,
}

// ─── Public Configuration Types ───────────────────────────────────────────────

/**
 * Per-table sync configuration.
 *
 * @example
 * { tableName: 'public.users', trackingColumn: 'id' }
 */
export interface TableSyncConfig {
    /**
     * Fully-qualified or plain table name in the external source.
     * Schema prefix (e.g. `public.`) is stripped when creating the
     * equivalent SQLite table.
     */
    tableName: string

    /**
     * Column used as an append-only cursor.  New rows are fetched
     * where `trackingColumn > lastValue`.  Choose a monotonically
     * increasing column such as `id` or `created_at`.
     */
    trackingColumn: string
}

export interface DataSyncPluginOptions {
    /** Database-specific adapter that handles schema introspection and row fetching. */
    source: DataSyncAdapter

    /**
     * Tables to synchronise, each with an explicit tracking column so
     * no column name is ever hardcoded.
     */
    tables: TableSyncConfig[]

    /**
     * How often to schedule the next sync alarm (milliseconds).
     * Defaults to 5 minutes.
     */
    syncIntervalMs?: number
}

// ─── Adapter Interface ────────────────────────────────────────────────────────

/**
 * Column descriptor returned by an adapter's `getColumns()` method.
 */
export interface ColumnInfo {
    name: string
    /** Database-native type string, e.g. `"varchar"`, `"int4"`, `"datetime"`. */
    nativeType: string
    /** Mapped SQLite affinity: TEXT | INTEGER | REAL | BLOB | NUMERIC */
    sqliteType: string
}

/**
 * Base class for database-specific adapters.  Subclass this and override
 * `getColumns()`, `fetchRows()`, and `mapType()` for each database engine.
 */
export abstract class DataSyncAdapter {
    /**
     * Return column metadata for the given table.
     * `tableName` is the *stripped* (no schema prefix) name.
     */
    abstract getColumns(tableName: string): Promise<ColumnInfo[]>

    /**
     * Fetch rows from the external source where `trackingColumn > lastValue`.
     * Return an ordered array of plain objects.
     */
    abstract fetchRows(opts: {
        tableName: string
        trackingColumn: string
        lastValue: string | null
        limit?: number
    }): Promise<Record<string, unknown>[]>

    /**
     * Map a native database type to a SQLite storage class.
     * Override in subclasses for engine-specific type systems.
     */
    abstract mapType(nativeType: string): string

    /** Optional: called once to establish/verify the connection. */
    async connect(): Promise<void> {}

    /** Optional: called once to release the connection. */
    async disconnect(): Promise<void> {}
}

// ─── PostgresSync Adapter ─────────────────────────────────────────────────────

export interface PostgresSyncOptions {
    host: string
    port?: number
    user: string
    password: string
    database: string
    ssl?: boolean
}

/**
 * Adapter that syncs data from a PostgreSQL source.
 *
 * Uses the `pg` driver which is already a project dependency.
 */
export class PostgresSync extends DataSyncAdapter {
    private opts: PostgresSyncOptions
    private client: any | null = null

    constructor(opts: PostgresSyncOptions) {
        super()
        this.opts = opts
    }

    override async connect(): Promise<void> {
        // Dynamic import so the module is only loaded when the adapter is used
        const { Client } = await import('pg')
        this.client = new Client({
            host: this.opts.host,
            port: this.opts.port ?? 5432,
            user: this.opts.user,
            password: this.opts.password,
            database: this.opts.database,
            ssl: this.opts.ssl ? { rejectUnauthorized: false } : undefined,
        })
        await this.client.connect()
    }

    override async disconnect(): Promise<void> {
        if (this.client) {
            await this.client.end()
            this.client = null
        }
    }

    override mapType(nativeType: string): string {
        const t = nativeType.toLowerCase()
        if (
            t.includes('int') ||
            t === 'serial' ||
            t === 'bigserial' ||
            t === 'smallserial' ||
            t === 'boolean' ||
            t === 'bool'
        ) {
            return 'INTEGER'
        }
        if (
            t.includes('float') ||
            t.includes('double') ||
            t.includes('real') ||
            t.includes('numeric') ||
            t.includes('decimal') ||
            t === 'money'
        ) {
            return 'REAL'
        }
        if (t === 'bytea') {
            return 'BLOB'
        }
        return 'TEXT'
    }

    override async getColumns(tableName: string): Promise<ColumnInfo[]> {
        if (!this.client) await this.connect()

        // Support schema-qualified names in the external source
        let schema = 'public'
        let table = tableName
        if (tableName.includes('.')) {
            const parts = tableName.split('.')
            schema = parts[0]
            table = parts[1]
        }

        const result = await this.client.query(
            `SELECT column_name, data_type
             FROM   information_schema.columns
             WHERE  table_schema = $1
               AND  table_name   = $2
             ORDER  BY ordinal_position`,
            [schema, table]
        )

        return result.rows.map(
            (row: { column_name: string; data_type: string }) => ({
                name: row.column_name,
                nativeType: row.data_type,
                sqliteType: this.mapType(row.data_type),
            })
        )
    }

    override async fetchRows(opts: {
        tableName: string
        trackingColumn: string
        lastValue: string | null
        limit?: number
    }): Promise<Record<string, unknown>[]> {
        if (!this.client) await this.connect()

        const { tableName, trackingColumn, lastValue, limit = 1000 } = opts

        // Use the original (possibly schema-qualified) name for the external query
        let query: string
        let params: unknown[]

        if (lastValue !== null && lastValue !== undefined) {
            query = `SELECT * FROM "${tableName}" WHERE "${trackingColumn}" > $1 ORDER BY "${trackingColumn}" ASC LIMIT $2`
            params = [lastValue, limit]
        } else {
            query = `SELECT * FROM "${tableName}" ORDER BY "${trackingColumn}" ASC LIMIT $1`
            params = [limit]
        }

        const result = await this.client.query(query, params)
        return result.rows
    }
}

// ─── MySQLSync Adapter ────────────────────────────────────────────────────────

export interface MySQLSyncOptions {
    host: string
    port?: number
    user: string
    password: string
    database: string
    ssl?: boolean
}

/**
 * Adapter that syncs data from a MySQL / MariaDB source.
 *
 * Uses the `mysql2` driver which is already a project dependency.
 */
export class MySQLSync extends DataSyncAdapter {
    private opts: MySQLSyncOptions
    private connection: any | null = null

    constructor(opts: MySQLSyncOptions) {
        super()
        this.opts = opts
    }

    override async connect(): Promise<void> {
        const mysql = await import('mysql2/promise')
        this.connection = await mysql.createConnection({
            host: this.opts.host,
            port: this.opts.port ?? 3306,
            user: this.opts.user,
            password: this.opts.password,
            database: this.opts.database,
            ssl: this.opts.ssl ? {} : undefined,
        })
    }

    override async disconnect(): Promise<void> {
        if (this.connection) {
            await this.connection.end()
            this.connection = null
        }
    }

    override mapType(nativeType: string): string {
        const t = nativeType.toLowerCase()
        if (
            t.includes('int') ||
            t === 'tinyint' ||
            t === 'smallint' ||
            t === 'mediumint' ||
            t === 'bigint' ||
            t === 'bit' ||
            t === 'boolean' ||
            t === 'bool'
        ) {
            return 'INTEGER'
        }
        if (
            t === 'float' ||
            t === 'double' ||
            t.includes('decimal') ||
            t.includes('numeric') ||
            t === 'real'
        ) {
            return 'REAL'
        }
        if (t === 'blob' || t.includes('binary') || t === 'varbinary') {
            return 'BLOB'
        }
        return 'TEXT'
    }

    override async getColumns(tableName: string): Promise<ColumnInfo[]> {
        if (!this.connection) await this.connect()

        // MySQL uses backtick-quoted names; strip schema if provided
        let schema = this.opts.database
        let table = tableName
        if (tableName.includes('.')) {
            const parts = tableName.split('.')
            schema = parts[0]
            table = parts[1]
        }

        const [rows] = await this.connection.execute(
            `SELECT COLUMN_NAME as column_name, DATA_TYPE as data_type
             FROM   information_schema.COLUMNS
             WHERE  TABLE_SCHEMA = ?
               AND  TABLE_NAME   = ?
             ORDER  BY ORDINAL_POSITION`,
            [schema, table]
        )

        return (rows as Array<{ column_name: string; data_type: string }>).map(
            (row) => ({
                name: row.column_name,
                nativeType: row.data_type,
                sqliteType: this.mapType(row.data_type),
            })
        )
    }

    override async fetchRows(opts: {
        tableName: string
        trackingColumn: string
        lastValue: string | null
        limit?: number
    }): Promise<Record<string, unknown>[]> {
        if (!this.connection) await this.connect()

        const { tableName, trackingColumn, lastValue, limit = 1000 } = opts

        let query: string
        let params: unknown[]

        if (lastValue !== null && lastValue !== undefined) {
            query = `SELECT * FROM \`${tableName}\` WHERE \`${trackingColumn}\` > ? ORDER BY \`${trackingColumn}\` ASC LIMIT ?`
            params = [lastValue, limit]
        } else {
            query = `SELECT * FROM \`${tableName}\` ORDER BY \`${trackingColumn}\` ASC LIMIT ?`
            params = [limit]
        }

        const [rows] = await this.connection.execute(query, params)
        return rows as Record<string, unknown>[]
    }
}

// ─── DataSyncPlugin ───────────────────────────────────────────────────────────

/**
 * Plugin that incrementally pulls data from an external PostgreSQL or MySQL
 * database into the Cloudflare Durable Object SQLite store.
 *
 * @example
 * ```ts
 * new DataSyncPlugin({
 *   source: new PostgresSync({ host: 'db.example.com', user: 'app', password: 'secret', database: 'prod' }),
 *   tables: [
 *     { tableName: 'public.users',    trackingColumn: 'id'         },
 *     { tableName: 'public.events',   trackingColumn: 'created_at' },
 *   ],
 *   syncIntervalMs: 5 * 60 * 1000,
 * })
 * ```
 */
export class DataSyncPlugin extends StarbasePlugin {
    private pluginOpts: DataSyncPluginOptions
    private dataSource?: DataSource
    private syncIntervalMs: number

    constructor(opts: DataSyncPluginOptions) {
        super('starbasedb:data-sync', { requiresAuth: true })
        this.pluginOpts = opts
        this.syncIntervalMs = opts.syncIntervalMs ?? 5 * 60 * 1000
    }

    // ── Helpers ─────────────────────────────────────────────────────────────

    /**
     * Strip a PostgreSQL-style `public.` schema prefix so the local SQLite
     * table uses only the bare table name.
     */
    private stripSchemaPrefix(tableName: string): string {
        // Strip "public." prefix (case-insensitive)
        if (/^public\./i.test(tableName)) {
            return tableName.slice(tableName.indexOf('.') + 1)
        }
        // For any other schema (e.g. "myschema.users") keep as-is so there is
        // no silent data loss; callers can override via the beforeQuery hook.
        return tableName
    }

    // ── Plugin lifecycle ────────────────────────────────────────────────────

    override async register(app: StarbaseApp): Promise<void> {
        app.use(async (c, next) => {
            this.dataSource = c?.get('dataSource')
            await this.init()
            // Schedule the first alarm so syncs begin automatically
            await this.scheduleNextAlarm()
            await next()
        })

        // Manual trigger endpoint (admin-only)
        app.post('/_internal/data-sync/trigger', async (c) => {
            const config = c.get('config')
            if (config?.role !== 'admin') {
                return new Response('Unauthorized', { status: 401 })
            }
            try {
                await this.runSync()
                return new Response(JSON.stringify({ success: true }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                })
            } catch (err) {
                return new Response(
                    JSON.stringify({ success: false, error: String(err) }),
                    {
                        status: 500,
                        headers: { 'Content-Type': 'application/json' },
                    }
                )
            }
        })

        // Status endpoint (admin-only)
        app.get('/_internal/data-sync/status', async (c) => {
            const config = c.get('config')
            if (config?.role !== 'admin') {
                return new Response('Unauthorized', { status: 401 })
            }
            const status = await this.getStatus()
            return new Response(JSON.stringify(status), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            })
        })
    }

    // ── Initialization ──────────────────────────────────────────────────────

    private async init(): Promise<void> {
        if (!this.dataSource) return
        await this.dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.CREATE_METADATA_TABLE,
            params: [],
        })
    }

    // ── Alarm scheduling ────────────────────────────────────────────────────

    /**
     * Schedule the Durable Object alarm for the next sync cycle.
     * Uses DO alarms (not setInterval) as required by Cloudflare.
     */
    private async scheduleNextAlarm(): Promise<void> {
        if (!this.dataSource) return
        const nextTime = Date.now() + this.syncIntervalMs
        await this.dataSource.rpc.setAlarm(nextTime)
    }

    // ── Sync logic ───────────────────────────────────────────────────────────

    /**
     * Run a full sync cycle: for each configured table, fetch new rows from
     * the external source and upsert them into the local SQLite table.
     */
    public async runSync(): Promise<void> {
        if (!this.dataSource) return

        const adapter = this.pluginOpts.source

        try {
            await adapter.connect()

            for (const tableConfig of this.pluginOpts.tables) {
                try {
                    await this.syncTable(tableConfig)
                } catch (err) {
                    console.error(
                        `[DataSyncPlugin] Failed to sync table "${tableConfig.tableName}":`,
                        err
                    )
                }
            }
        } finally {
            await adapter.disconnect()
        }

        // Re-schedule next alarm after a successful (or partially-successful) run
        await this.scheduleNextAlarm()
    }

    private async syncTable(tableConfig: TableSyncConfig): Promise<void> {
        const { tableName, trackingColumn } = tableConfig
        const localTableName = this.stripSchemaPrefix(tableName)

        // Retrieve last cursor value from metadata
        const metaRows = (await this.dataSource!.rpc.executeQuery({
            sql: SQL_QUERIES.GET_METADATA,
            params: [localTableName],
        })) as Array<{
            table_name: string
            tracking_col: string
            last_value: string | null
        }>

        const lastValue = metaRows.length > 0 ? metaRows[0].last_value : null

        // Fetch new rows from the external source
        const rows = await this.pluginOpts.source.fetchRows({
            tableName,
            trackingColumn,
            lastValue,
        })

        if (rows.length === 0) return

        // Ensure the local table exists with the correct schema
        const columns = await this.pluginOpts.source.getColumns(tableName)
        await this.ensureLocalTable(localTableName, columns)

        // Upsert rows into the local SQLite table
        for (const row of rows) {
            await this.upsertRow(localTableName, columns, row)
        }

        // Update the cursor to the last row's tracking-column value
        const lastRow = rows[rows.length - 1]
        const newLastValue = String(lastRow[trackingColumn] ?? '')

        await this.dataSource!.rpc.executeQuery({
            sql: SQL_QUERIES.UPSERT_METADATA,
            params: [localTableName, trackingColumn, newLastValue],
        })
    }

    /**
     * Create the local SQLite mirror table if it does not already exist.
     */
    private async ensureLocalTable(
        localTableName: string,
        columns: ColumnInfo[]
    ): Promise<void> {
        if (!columns.length) return

        const colDefs = columns
            .map((c) => `"${c.name}" ${c.sqliteType}`)
            .join(', ')

        const sql = `CREATE TABLE IF NOT EXISTS "${localTableName}" (${colDefs})`
        await this.dataSource!.rpc.executeQuery({ sql, params: [] })
    }

    /**
     * Insert or replace a single row into the local SQLite table.
     */
    private async upsertRow(
        localTableName: string,
        columns: ColumnInfo[],
        row: Record<string, unknown>
    ): Promise<void> {
        const colNames = columns.map((c) => `"${c.name}"`).join(', ')
        const placeholders = columns.map(() => '?').join(', ')
        const values = columns.map((c) => {
            const v = row[c.name]
            if (v === null || v === undefined) return null
            if (v instanceof Date) return v.toISOString()
            if (typeof v === 'object') return JSON.stringify(v)
            return v
        })

        const sql = `INSERT OR REPLACE INTO "${localTableName}" (${colNames}) VALUES (${placeholders})`
        await this.dataSource!.rpc.executeQuery({ sql, params: values })
    }

    // ── Status ───────────────────────────────────────────────────────────────

    private async getStatus(): Promise<Record<string, unknown>> {
        if (!this.dataSource) return { error: 'not initialised' }

        const rows = (await this.dataSource.rpc.executeQuery({
            sql: 'SELECT * FROM tmp_data_sync_metadata',
            params: [],
        })) as Array<Record<string, unknown>>

        const nextAlarm = await this.dataSource.rpc.getAlarm()

        return {
            tables: rows,
            nextAlarmMs: nextAlarm,
            syncIntervalMs: this.syncIntervalMs,
        }
    }

    // ── Query hooks ──────────────────────────────────────────────────────────

    /**
     * Rewrite SQL so that `public.<table>` references resolve to the bare
     * `<table>` name used in the local SQLite store.
     *
     * e.g. `SELECT * FROM public.users` → `SELECT * FROM users`
     */
    override async beforeQuery(opts: {
        sql: string
        params?: unknown[]
        dataSource?: DataSource
        config?: StarbaseDBConfiguration
    }): Promise<{ sql: string; params?: unknown[] }> {
        // Replace all occurrences of `public.tablename` (with optional quotes)
        // using a case-insensitive regex.
        const rewritten = opts.sql.replace(
            /\bpublic\."?([A-Za-z_][A-Za-z0-9_]*)"?/gi,
            '$1'
        )

        return { sql: rewritten, params: opts.params }
    }

    override async afterQuery(opts: {
        sql: string
        result: any
        isRaw: boolean
        dataSource?: DataSource
        config?: StarbaseDBConfiguration
    }): Promise<any> {
        return opts.result
    }
}
