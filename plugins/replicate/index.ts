import { StarbaseApp, StarbaseDBConfiguration } from '../../src/handler'
import { StarbasePlugin } from '../../src/plugin'
import { DataSource, QueryResult } from '../../src/types'
import { createResponse } from '../../src/utils'

/** Per-table replication rule. */
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
}

/** Options for {@link ReplicatePlugin}. */
export interface ReplicatePluginOptions {
    /**
     * Tables to replicate. When omitted, every base table found in the
     * external source is replicated with a full re-sync.
     */
    tables?: ReplicateTableConfig[]
    /** Rows pulled per batch. Bounds memory use. Defaults to 1000. */
    batchSize?: number
}

/** Outcome of replicating a single table. */
export interface ReplicateTableResult {
    table: string
    mode: 'incremental' | 'full'
    rowsReplicated: number
}

const META_TABLE = 'tmp_replicate_cursors'

/**
 * Pulls data from the configured external data source into the internal
 * Durable Object SQLite database, so the instance can serve as a
 * close-to-edge read replica.
 *
 * Designed for large tables: rows are streamed one bounded batch at a time,
 * and incremental tables use **keyset pagination** (`WHERE cursor > ?`) whose
 * cursor advances every batch — O(n) over the table. `LIMIT/OFFSET` would
 * re-scan every skipped row on each batch (O(n²)).
 *
 * `runReplication()` is public so interval-based pulling can be wired up by
 * calling it from a `CronPlugin` callback.
 */
export class ReplicatePlugin extends StarbasePlugin {
    public pathPrefix = '/replicate'
    private dataSource?: DataSource
    private config?: StarbaseDBConfiguration
    private readonly tables: ReplicateTableConfig[]
    private readonly batchSize: number

    constructor(options: ReplicatePluginOptions = {}) {
        super('starbasedb:replicate', { requiresAuth: true })
        this.tables = options.tables ?? []
        this.batchSize =
            options.batchSize && options.batchSize > 0
                ? options.batchSize
                : 1000
    }

    override async register(app: StarbaseApp) {
        // dataSource + config are only available per-request from the Hono
        // context, so capture them here (same pattern as the cron plugin).
        app.use(async (c, next) => {
            this.dataSource = c?.get('dataSource')
            this.config = c?.get('config')
            await next()
        })

        // POST /replicate/run — trigger one replication cycle.
        app.post(`${this.pathPrefix}/run`, async () => {
            if (this.config?.role !== 'admin') {
                return createResponse(undefined, 'Unauthorized', 401)
            }
            try {
                const results = await this.runReplication()
                return createResponse({ results }, undefined, 200)
            } catch (error: any) {
                return createResponse(
                    undefined,
                    error?.message ?? 'Replication failed',
                    500
                )
            }
        })

        // GET /replicate/status — last cursor + run info per table.
        app.get(`${this.pathPrefix}/status`, async () => {
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
    }

    /**
     * Run one replication cycle across every configured table. Safe to call
     * directly — e.g. from a `CronPlugin` callback for interval-based pulling.
     */
    public async runReplication(): Promise<ReplicateTableResult[]> {
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
            results.push(await this.replicateTable(target))
        }
        return results
    }

    // ── internals ───────────────────────────────────────────────────────────

    private async replicateTable(
        cfg: ReplicateTableConfig
    ): Promise<ReplicateTableResult> {
        const { table } = cfg
        const cursorColumn = cfg.cursorColumn ?? null
        const columnList =
            cfg.columns && cfg.columns.length > 0
                ? cfg.columns.map(quoteIdentifier).join(', ')
                : '*'

        let cursor: unknown = cursorColumn
            ? await this.loadCursor(table)
            : null
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
                // Keyset pagination: advance the cursor to the last row's
                // value so the next batch resumes exactly where this one
                // ended — no OFFSET, no re-scanning skipped rows.
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
            // No cursor column: there is no ordering key for keyset
            // pagination, so a full re-sync pages with LIMIT/OFFSET.
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
                cursor === null || cursor === undefined
                    ? null
                    : String(cursor),
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
        // Infer a column->type map across the whole batch, so a NULL in the
        // first row does not wrongly collapse a column to TEXT.
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

    private async writeRows(
        table: string,
        rows: QueryResult[]
    ): Promise<void> {
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

    /** Query the internal Durable Object SQLite database. */
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

    /** Query the configured external data source. */
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

// ── helpers ──────────────────────────────────────────────────────────────────

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
