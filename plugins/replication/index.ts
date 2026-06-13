import { StarbaseApp, StarbaseDBConfiguration } from '../../src/handler'
import { StarbasePlugin } from '../../src/plugin'
import { DataSource, QueryResult } from '../../src/types'
import { createResponse } from '../../src/utils'

export interface ReplicateTableConfig {
    /** Table name in the external source. */
    table: string
    /**
     * Column used for incremental, append-only polling (e.g. `id` or
     * `updated_at`). When set, each run only pulls rows whose value is greater
     * than the highest value already replicated. When omitted, the table is
     * fully re-synced on every run.
     */
    cursorColumn?: string
    /** Columns to pull. Defaults to every column (`*`). */
    columns?: string[]
    /** Optional interval in seconds to sync this specific table. */
    interval?: number
}

export interface ReplicatePluginOptions {
    /**
     * Tables to replicate. When omitted, every base table found in the
     * external source is replicated.
     */
    tables?: ReplicateTableConfig[]
    /** Rows pulled per batch. Bounds memory use. Defaults to 1000. */
    batchSize?: number
    /** Cloudflare ExecutionContext for waitUntil support */
    ctx?: ExecutionContext
    /** Cron interval expression (e.g. 'every 5 minutes') or interval in seconds to automatically run replication. */
    interval?: string | number
}

export interface ReplicateTableResult {
    table: string
    mode: 'incremental' | 'full'
    rowsReplicated: number
    status: 'synced' | 'skipped' | 'error'
    error?: string
}

const META_TABLE = 'tmp_replicate_cursors'

export class ReplicationPlugin extends StarbasePlugin {
    public pathPrefix = '/replicate'
    private dataSource?: DataSource
    private config?: StarbaseDBConfiguration
    private readonly tables: ReplicateTableConfig[]
    private readonly batchSize: number
    private readonly executionContext?: ExecutionContext
    private readonly autoInterval?: string | number

    constructor(options: ReplicatePluginOptions = {}) {
        super('starbasedb:replication', { requiresAuth: true })
        this.tables = options.tables ?? []
        this.batchSize =
            options.batchSize && options.batchSize > 0
                ? options.batchSize
                : 1000
        this.executionContext = options.ctx
        this.autoInterval = options.interval
    }

    override async register(app: StarbaseApp) {
        // Capture context via middleware
        app.use(async (c, next) => {
            this.dataSource = c.get('dataSource')
            this.config = c.get('config')

            // If an autoInterval is configured and we have a dataSource, bootstrap the auto cron task
            if (this.autoInterval && this.dataSource) {
                const requestUrl = new URL(c.req.url)
                const callbackHost = requestUrl.origin
                // We use c.executionCtx if this.executionContext is not provided
                const ctx = this.executionContext ?? getExecutionCtx(c)
                if (ctx) {
                    ctx.waitUntil(this.setupAutomaticCron(callbackHost))
                } else {
                    await this.setupAutomaticCron(callbackHost)
                }
            }

            await next()
        })

        // POST /replicate/run — trigger replication.
        app.post(`${this.pathPrefix}/run`, async (c) => {
            if (this.config?.role !== 'admin') {
                return createResponse(undefined, 'Unauthorized', 401)
            }
            try {
                // Determine if we should force sync all tables (default to true on manual run)
                const results = await this.runReplication(true)
                return createResponse({ results }, undefined, 200)
            } catch (error: any) {
                return createResponse(
                    undefined,
                    error?.message ?? 'Replication failed',
                    500
                )
            }
        })

        // GET /replicate/status — get replication status.
        app.get(`${this.pathPrefix}/status`, async (c) => {
            if (this.config?.role !== 'admin') {
                return createResponse(undefined, 'Unauthorized', 401)
            }
            try {
                await this.ensureMetaTable()
                const tables = await this.internalQuery(
                    `SELECT table_name, cursor_column, last_cursor, last_run_at, rows_replicated FROM ${META_TABLE} ORDER BY table_name`,
                    []
                )
                return createResponse({ tables }, undefined, 200)
            } catch (error: any) {
                return createResponse(
                    undefined,
                    error?.message ?? 'Failed to read replication status',
                    500
                )
            }
        })

        // Intercept cron callback to run replication if our auto task triggers
        app.use(`/cron/callback`, async (c, next) => {
            let triggered = false
            if (c.req.method === 'POST') {
                try {
                    const payload = (await c.req.raw.clone().json()) as any[]
                    const replicationTask = payload.find(
                        (t) => t.name === 'starbasedb:replication'
                    )
                    if (replicationTask) {
                        triggered = true
                        const ctx = this.executionContext ?? getExecutionCtx(c)
                        const promise = this.runReplication(false)
                        if (ctx) {
                            ctx.waitUntil(promise)
                        } else {
                            await promise
                        }
                    }
                } catch (e) {
                    // Ignore parsing/execution errors
                }
            }
            await next()
            if (triggered && c.res.status === 404) {
                c.res = createResponse({ success: true }, undefined, 200)
            }
        })
    }

    private async setupAutomaticCron(callbackHost: string): Promise<void> {
        try {
            await this.internalQuery(
                `CREATE TABLE IF NOT EXISTS tmp_cron_tasks (
                    name TEXT NOT NULL UNIQUE PRIMARY KEY,
                    cron_tab TEXT NOT NULL,
                    payload TEXT,
                    callback_host TEXT,
                    is_active INTEGER
                )`,
                []
            )

            let cronTab = '* * * * *' // default check every minute
            if (typeof this.autoInterval === 'string') {
                cronTab = this.autoInterval
            } else if (typeof this.autoInterval === 'number') {
                if (this.autoInterval >= 60) {
                    const mins = Math.floor(this.autoInterval / 60)
                    cronTab = mins === 1 ? '* * * * *' : `*/${mins} * * * *`
                }
            }

            const existing = (await this.internalQuery(
                `SELECT cron_tab, callback_host FROM tmp_cron_tasks WHERE name = ?`,
                ['starbasedb:replication']
            )) as any[]

            if (
                existing.length === 0 ||
                existing[0].cron_tab !== cronTab ||
                existing[0].callback_host !== callbackHost
            ) {
                await this.internalQuery(
                    `INSERT OR REPLACE INTO tmp_cron_tasks (name, cron_tab, payload, callback_host, is_active)
                     VALUES (?, ?, ?, ?, ?)`,
                    ['starbasedb:replication', cronTab, '{}', callbackHost, 1]
                )

                // Reschedule DO alarm
                await this.dataSource!.rpc.setAlarm(Date.now() + 10000)
            }
        } catch (error) {
            console.error(
                '[replication] failed to setup automatic cron:',
                error
            )
        }
    }

    public async runReplication(
        force: boolean = false
    ): Promise<ReplicateTableResult[]> {
        if (!this.dataSource) {
            throw new Error('dataSource not available')
        }
        if (!this.dataSource.external) {
            throw new Error(
                'No external data source configured for replication'
            )
        }

        await this.ensureMetaTable()

        const targets =
            this.tables.length > 0
                ? this.tables
                : await this.discoverExternalTables()

        const results: ReplicateTableResult[] = []
        for (const target of targets) {
            try {
                if (!force && target.interval && target.interval > 0) {
                    const lastRun = await this.getLastRunAt(target.table)
                    if (lastRun) {
                        const elapsedSeconds =
                            (Date.now() - lastRun.getTime()) / 1000
                        if (elapsedSeconds < target.interval) {
                            results.push({
                                table: target.table,
                                mode: target.cursorColumn
                                    ? 'incremental'
                                    : 'full',
                                rowsReplicated: 0,
                                status: 'skipped',
                            })
                            continue
                        }
                    }
                }

                const res = await this.replicateTable(target)
                results.push({
                    ...res,
                    status: 'synced',
                })
            } catch (error: any) {
                console.error(
                    `[replication] error syncing table "${target.table}":`,
                    error
                )
                results.push({
                    table: target.table,
                    mode: target.cursorColumn ? 'incremental' : 'full',
                    rowsReplicated: 0,
                    status: 'error',
                    error: error?.message ?? String(error),
                })
            }
        }
        return results
    }

    private async getLastRunAt(table: string): Promise<Date | null> {
        try {
            const rows = (await this.internalQuery(
                `SELECT last_run_at FROM ${META_TABLE} WHERE table_name = ?`,
                [table]
            )) as QueryResult[]
            const lastRunStr = rows[0]?.last_run_at
            if (lastRunStr) {
                return new Date(String(lastRunStr))
            }
        } catch (e) {
            // ignore
        }
        return null
    }

    private async replicateTable(
        cfg: ReplicateTableConfig
    ): Promise<{
        table: string
        mode: 'incremental' | 'full'
        rowsReplicated: number
    }> {
        const { table } = cfg
        const cursorColumn = cfg.cursorColumn ?? null
        const columnList =
            cfg.columns && cfg.columns.length > 0
                ? cfg.columns.map(quoteIdentifier).join(', ')
                : '*'

        let cursor: unknown = cursorColumn ? await this.loadCursor(table) : null
        let rowsReplicated = 0

        while (true) {
            const { sql, params } = this.buildFetchQuery(
                table,
                columnList,
                cursorColumn,
                cursor,
                rowsReplicated
            )
            const rows = (await this.externalQuery(
                sql,
                params
            )) as QueryResult[]
            if (!rows || rows.length === 0) {
                break
            }

            await this.ensureDestinationTable(table, rows)
            await this.writeRows(table, rows)
            rowsReplicated += rows.length

            if (cursorColumn) {
                const lastValue = rows[rows.length - 1][cursorColumn]
                if (lastValue !== undefined && lastValue !== null) {
                    cursor = lastValue
                }
                await this.saveCursor(
                    table,
                    cursorColumn,
                    cursor,
                    rowsReplicated
                )
            }

            if (rows.length < this.batchSize) {
                break
            }
        }

        if (!cursorColumn) {
            await this.saveCursor(table, null, null, rowsReplicated)
        }

        return {
            table,
            mode: cursorColumn ? 'incremental' : 'full',
            rowsReplicated,
        }
    }

    private buildFetchQuery(
        table: string,
        columnList: string,
        cursorColumn: string | null,
        cursor: unknown,
        offset: number
    ): { sql: string; params: unknown[] } {
        const params: unknown[] = []
        let sql = `SELECT ${columnList} FROM ${quoteIdentifier(table)}`

        if (cursorColumn) {
            if (cursor !== null && cursor !== undefined) {
                sql += ` WHERE ${quoteIdentifier(cursorColumn)} > ?`
                params.push(cursor)
            }
            sql += ` ORDER BY ${quoteIdentifier(cursorColumn)} ASC LIMIT ${this.batchSize}`
        } else {
            sql += ` LIMIT ${this.batchSize} OFFSET ${offset}`
        }

        return { sql, params }
    }

    private async ensureMetaTable(): Promise<void> {
        await this.internalQuery(
            `CREATE TABLE IF NOT EXISTS ${META_TABLE} (
                table_name      TEXT NOT NULL PRIMARY KEY,
                cursor_column   TEXT,
                last_cursor     TEXT,
                last_run_at     TEXT,
                rows_replicated INTEGER
            )`,
            []
        )
    }

    private async loadCursor(table: string): Promise<unknown> {
        const rows = (await this.internalQuery(
            `SELECT last_cursor FROM ${META_TABLE} WHERE table_name = ?`,
            [table]
        )) as QueryResult[]
        return rows[0]?.last_cursor ?? null
    }

    private async saveCursor(
        table: string,
        cursorColumn: string | null,
        cursor: unknown,
        rowsReplicated: number
    ): Promise<void> {
        await this.internalQuery(
            `INSERT INTO ${META_TABLE}
                (table_name, cursor_column, last_cursor, last_run_at, rows_replicated)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(table_name) DO UPDATE SET
                cursor_column   = excluded.cursor_column,
                last_cursor     = excluded.last_cursor,
                last_run_at     = excluded.last_run_at,
                rows_replicated = excluded.rows_replicated`,
            [
                table,
                cursorColumn,
                cursor === null || cursor === undefined ? null : String(cursor),
                new Date().toISOString(),
                rowsReplicated,
            ]
        )
    }

    private async discoverExternalTables(): Promise<ReplicateTableConfig[]> {
        const external = this.dataSource!.external as { dialect?: string }
        const sql =
            external?.dialect === 'sqlite'
                ? "SELECT name AS table_name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
                : "SELECT table_name FROM information_schema.tables WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('information_schema', 'pg_catalog', 'mysql', 'performance_schema', 'sys')"

        const rows = (await this.externalQuery(sql, [])) as QueryResult[]
        return rows
            .map((r) => String(r.table_name ?? r.name ?? ''))
            .filter((name) => name.length > 0)
            .map((table) => ({ table }))
    }

    private async ensureDestinationTable(
        table: string,
        rows: QueryResult[]
    ): Promise<void> {
        const types = new Map<string, string>()
        for (const row of rows) {
            for (const [col, value] of Object.entries(row)) {
                if (!types.has(col) && value !== null) {
                    types.set(col, sqliteType(value))
                }
            }
        }
        for (const col of Object.keys(rows[0])) {
            if (!types.has(col)) {
                types.set(col, 'TEXT')
            }
        }

        const columnDefs = [...types.entries()]
            .map(([col, type]) => `${quoteIdentifier(col)} ${type}`)
            .join(', ')
        await this.internalQuery(
            `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(table)} (${columnDefs})`,
            []
        )
    }

    private async writeRows(table: string, rows: QueryResult[]): Promise<void> {
        for (const row of rows) {
            const columns = Object.keys(row)
            const placeholders = columns.map(() => '?').join(', ')
            const values = columns.map((col) => toSqliteValue(row[col]))
            await this.internalQuery(
                `INSERT OR REPLACE INTO ${quoteIdentifier(table)} (${columns
                    .map(quoteIdentifier)
                    .join(', ')}) VALUES (${placeholders})`,
                values
            )
        }
    }

    private async internalQuery(
        sql: string,
        params: unknown[]
    ): Promise<unknown[]> {
        const result = await this.dataSource!.rpc.executeQuery({
            sql,
            params,
        })
        return (result as unknown[]) ?? []
    }

    private async externalQuery(
        sql: string,
        params: unknown[]
    ): Promise<unknown[]> {
        const { executeQuery } = await import('../../src/operation')
        const result = await executeQuery({
            sql,
            params,
            isRaw: false,
            dataSource: { ...this.dataSource!, source: 'external' },
            config: this.config!,
        })
        return (result as unknown[]) ?? []
    }
}

function quoteIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`
}

function sqliteType(value: unknown): string {
    if (typeof value === 'number') {
        return Number.isInteger(value) ? 'INTEGER' : 'REAL'
    }
    if (typeof value === 'bigint' || typeof value === 'boolean') {
        return 'INTEGER'
    }
    return 'TEXT'
}

function toSqliteValue(value: unknown): unknown {
    if (value === null || value === undefined) return null
    if (typeof value === 'boolean') return value ? 1 : 0
    if (value instanceof Date) return value.toISOString()
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value
    if (typeof value === 'object') return JSON.stringify(value)
    return value
}

function getExecutionCtx(c: any): ExecutionContext | undefined {
    try {
        return c.executionCtx
    } catch {
        return undefined
    }
}
