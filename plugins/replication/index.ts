import {
    StarbaseApp,
    StarbaseContext,
    StarbaseDBConfiguration,
} from '../../src/handler'
import { executeExternalQuery } from '../../src/operation'
import { StarbasePlugin } from '../../src/plugin'
import {
    DataSource,
    ExternalDatabaseSource,
    QueryResult,
} from '../../src/types'
import { createResponse } from '../../src/utils'

/**
 * Per-table replication settings.
 *
 * Maps to the three "additional context" bullets on issue #72:
 *  - which tables should have data pulled    -> caller picks them explicitly here
 *  - what column to base append/upsert on    -> `cursorColumn`
 *  - how to identify a row for upsert        -> `primaryKey` (defaults to `cursorColumn`)
 */
export interface ReplicationTableConfig {
    /** Table name on both sides (when source/dest names match). Required. */
    table: string
    /** Override source-side name if it differs from `table`. */
    sourceTable?: string
    /** Override destination-side name if it differs from `table`. */
    destTable?: string
    /**
     * Column used as the high-water mark. Must be monotonically non-decreasing
     * across inserts/updates of interest (e.g. `id`, `updated_at`, `seq`).
     * Pulls use `WHERE <cursorColumn> > ? ORDER BY <cursorColumn> ASC`.
     */
    cursorColumn: string
    /**
     * Primary key on the destination table. Used to upsert. Defaults to
     * `[cursorColumn]` (i.e. the cursor column doubles as the row identity)
     * which is the right default for `id`-keyed append-only tables.
     */
    primaryKey?: string | string[]
    /**
     * Optional explicit column allowlist projected from the source. Defaults
     * to `*` (every column the source returns is forwarded to the destination
     * as-is). Names are passed through unquoted; pick safe identifiers.
     */
    columns?: string[]
    /** Override per-table page size; defaults to plugin-level pageSize. */
    pageSize?: number
}

export interface ReplicationPluginOptions {
    /**
     * The external source to pull rows FROM. Any `ExternalDatabaseSource`
     * already supported by `executeExternalQuery` works (Postgres, MySQL,
     * D1, Turso, StarbaseDB, Hyperdrive). When omitted, `tick()` falls back
     * to the active request's `dataSource.external`.
     */
    source?: ExternalDatabaseSource
    /**
     * Stable identifier for this source, used to scope state in
     * `tmp_replication_state`. Lets one DO host multiple replication
     * targets without colliding on cursors. Default: `"default"`.
     */
    sourceId?: string
    /** Tables to replicate. */
    tables: ReplicationTableConfig[]
    /** Plugin-wide page size. Default: 500. */
    pageSize?: number
    /**
     * Falls back through to `executeExternalQuery` when the Outerbase API
     * key path is required by the active config. Optional.
     */
    outerbaseApiKey?: string
    /** Mount path for admin endpoints. Default: `/replicate`. */
    pathPrefix?: string
}

export interface ReplicationTableResult {
    table: string
    rowsPulled: number
    cursorBefore: string | null
    cursorAfter: string | null
    morePagesAvailable: boolean
    error?: string
}

export interface ReplicationTickSummary {
    sourceId: string
    startedAt: string
    finishedAt: string
    perTable: ReplicationTableResult[]
}

const DEFAULT_PAGE_SIZE = 500
const STATE_TABLE = 'tmp_replication_state'

const SQL = {
    CREATE_STATE_TABLE: `
        CREATE TABLE IF NOT EXISTS ${STATE_TABLE} (
            source_id TEXT NOT NULL,
            table_name TEXT NOT NULL,
            cursor_column TEXT NOT NULL,
            cursor_value TEXT,
            last_run_ts INTEGER,
            last_rows_pulled INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            PRIMARY KEY (source_id, table_name)
        )
    `,
    GET_CURSOR: `
        SELECT cursor_value FROM ${STATE_TABLE}
        WHERE source_id = ? AND table_name = ?
    `,
    LIST_STATE: `
        SELECT source_id, table_name, cursor_column, cursor_value,
               last_run_ts, last_rows_pulled, last_error
        FROM ${STATE_TABLE}
        WHERE source_id = ?
    `,
    UPSERT_STATE: `
        INSERT INTO ${STATE_TABLE}
            (source_id, table_name, cursor_column, cursor_value,
             last_run_ts, last_rows_pulled, last_error)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_id, table_name) DO UPDATE SET
            cursor_column   = excluded.cursor_column,
            cursor_value    = excluded.cursor_value,
            last_run_ts     = excluded.last_run_ts,
            last_rows_pulled = excluded.last_rows_pulled,
            last_error      = excluded.last_error
    `,
}

const SQL_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

function assertIdent(value: string, kind: string): string {
    if (!SQL_IDENT_RE.test(value)) {
        throw new Error(
            `Invalid ${kind} identifier "${value}": must match ${SQL_IDENT_RE}`
        )
    }
    return value
}

function quoteIdent(value: string, kind: string): string {
    return `"${assertIdent(value, kind)}"`
}

interface ResolvedTable {
    sourceTable: string
    destTable: string
    cursorColumn: string
    primaryKey: string[]
    columns?: string[]
    pageSize: number
}

function resolveTable(
    cfg: ReplicationTableConfig,
    defaultPageSize: number
): ResolvedTable {
    const sourceTable = assertIdent(cfg.sourceTable ?? cfg.table, 'sourceTable')
    const destTable = assertIdent(cfg.destTable ?? cfg.table, 'destTable')
    const cursorColumn = assertIdent(cfg.cursorColumn, 'cursorColumn')
    const primaryKey = (
        Array.isArray(cfg.primaryKey)
            ? cfg.primaryKey
            : cfg.primaryKey
              ? [cfg.primaryKey]
              : [cursorColumn]
    ).map((c) => assertIdent(c, 'primaryKey'))
    const columns = cfg.columns?.map((c) => assertIdent(c, 'columns'))
    const pageSize =
        cfg.pageSize && cfg.pageSize > 0 ? cfg.pageSize : defaultPageSize

    return {
        sourceTable,
        destTable,
        cursorColumn,
        primaryKey,
        columns,
        pageSize,
    }
}

function buildSelect(t: ResolvedTable, hasCursor: boolean): string {
    const projection = t.columns?.length
        ? t.columns.map((c) => quoteIdent(c, 'columns')).join(', ')
        : '*'
    const cursorCol = quoteIdent(t.cursorColumn, 'cursorColumn')
    const where = hasCursor ? `WHERE ${cursorCol} > ?` : ''
    // No literal pageSize in the string - pass as a bound parameter where the
    // dialect supports it. SQLite/MySQL/Postgres all accept positional params
    // for LIMIT, but for portability across executeExternalQuery's two
    // codepaths (SDK + Outerbase API) we inline an integer that we have already
    // numerically validated. Safer than building a parameterised LIMIT and
    // hoping every dialect honours it.
    const limit = `LIMIT ${Math.max(1, Math.floor(t.pageSize))}`
    return `SELECT ${projection} FROM "${t.sourceTable}" ${where} ORDER BY ${cursorCol} ASC ${limit}`.trim()
}

function buildUpsert(t: ResolvedTable, columns: string[]): string {
    if (columns.length === 0) {
        throw new Error(
            `Replication: source table "${t.sourceTable}" returned 0 columns`
        )
    }
    const cols = columns.map((c) => quoteIdent(c, 'rowColumn')).join(', ')
    const placeholders = columns.map(() => '?').join(', ')
    const pk = t.primaryKey.map((c) => quoteIdent(c, 'primaryKey')).join(', ')
    const updates = columns
        .filter((c) => !t.primaryKey.includes(c))
        .map(
            (c) =>
                `${quoteIdent(c, 'rowColumn')} = excluded.${quoteIdent(c, 'rowColumn')}`
        )
        .join(', ')

    if (updates.length === 0) {
        return `INSERT OR IGNORE INTO "${t.destTable}" (${cols}) VALUES (${placeholders})`
    }
    return `INSERT INTO "${t.destTable}" (${cols}) VALUES (${placeholders}) ON CONFLICT(${pk}) DO UPDATE SET ${updates}`
}

function rowToColumnsAndValues(
    row: Record<string, unknown>,
    canonicalColumns?: string[]
): { columns: string[]; values: unknown[] } {
    const columns = canonicalColumns ?? Object.keys(row)
    const values = columns.map((c) => row[c] as unknown)
    return { columns, values }
}

function pickCursor(
    row: Record<string, unknown>,
    cursorColumn: string
): string | null {
    const v = row[cursorColumn]
    if (v === undefined || v === null) return null
    if (v instanceof Date) return v.toISOString()
    return String(v)
}

export class ReplicationPlugin extends StarbasePlugin {
    public readonly pathPrefix: string
    private readonly sourceId: string
    private readonly tables: ReplicationTableConfig[]
    private readonly pageSize: number
    private readonly source?: ExternalDatabaseSource
    private readonly outerbaseApiKey?: string
    private dataSource?: DataSource
    private config?: StarbaseDBConfiguration

    constructor(opts: ReplicationPluginOptions) {
        super('starbasedb:replication', { requiresAuth: true })
        if (!opts || !Array.isArray(opts.tables) || opts.tables.length === 0) {
            throw new Error(
                'ReplicationPlugin requires at least one table in `tables`'
            )
        }
        this.pathPrefix = opts.pathPrefix ?? '/replicate'
        this.sourceId = opts.sourceId ?? 'default'
        this.tables = opts.tables
        this.pageSize =
            opts.pageSize && opts.pageSize > 0
                ? opts.pageSize
                : DEFAULT_PAGE_SIZE
        this.source = opts.source
        this.outerbaseApiKey = opts.outerbaseApiKey
    }

    override async register(app: StarbaseApp): Promise<void> {
        app.use(async (c, next) => {
            this.dataSource = c.get('dataSource')
            this.config = c.get('config')
            await this.ensureStateTable()
            await next()
        })

        app.post(`${this.pathPrefix}/run`, async (c: StarbaseContext) => {
            const cfg = c.get('config')
            if (cfg?.role !== 'admin') {
                return createResponse(undefined, 'Unauthorized', 401)
            }
            try {
                const summary = await this.tick()
                return createResponse(summary, undefined, 200)
            } catch (err) {
                return createResponse(
                    undefined,
                    err instanceof Error ? err.message : String(err),
                    500
                )
            }
        })

        app.get(`${this.pathPrefix}/status`, async (c: StarbaseContext) => {
            const cfg = c.get('config')
            if (cfg?.role !== 'admin') {
                return createResponse(undefined, 'Unauthorized', 401)
            }
            const ds = c.get('dataSource')
            if (!ds) {
                return createResponse(undefined, 'No data source', 500)
            }
            const rows = (await ds.rpc.executeQuery({
                sql: SQL.LIST_STATE,
                params: [this.sourceId],
            })) as QueryResult[]
            return createResponse(
                {
                    sourceId: this.sourceId,
                    pageSize: this.pageSize,
                    tables: this.tables.map((t) => t.table),
                    state: rows,
                },
                undefined,
                200
            )
        })
    }

    private async ensureStateTable(): Promise<void> {
        if (!this.dataSource) return
        await this.dataSource.rpc.executeQuery({
            sql: SQL.CREATE_STATE_TABLE,
            params: [],
        })
    }

    /**
     * Run one replication pass over every configured table. Designed to be
     * called from the Worker `scheduled()` handler (cron trigger), from the
     * existing `CronPlugin.onEvent` callback, or via the `POST /replicate/run`
     * admin endpoint. One page per table per call - bounds runtime so we
     * never exceed Workers' subrequest budget.
     *
     * Pass `dataSource` and `config` explicitly when calling outside an HTTP
     * request (the registered middleware caches them only on request paths).
     */
    public async tick(opts?: {
        dataSource?: DataSource
        config?: StarbaseDBConfiguration
        source?: ExternalDatabaseSource
    }): Promise<ReplicationTickSummary> {
        const ds = opts?.dataSource ?? this.dataSource
        const cfg = opts?.config ?? this.config
        const source = opts?.source ?? this.source ?? ds?.external

        if (!ds) {
            throw new Error('ReplicationPlugin.tick: no internal data source')
        }
        if (!source) {
            throw new Error(
                'ReplicationPlugin.tick: no external source configured (pass via opts, plugin options, or dataSource.external)'
            )
        }

        await this.ensureStateTable.call({ dataSource: ds })
        // ensure state table exists when called outside the request middleware
        await ds.rpc.executeQuery({ sql: SQL.CREATE_STATE_TABLE, params: [] })

        const startedAt = new Date().toISOString()
        const perTable: ReplicationTableResult[] = []

        for (const tableCfg of this.tables) {
            try {
                const result = await this.replicateTable({
                    tableCfg,
                    ds,
                    cfg,
                    source,
                })
                perTable.push(result)
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err)
                // Best-effort record state; if the failure was identifier
                // validation we do not have a resolved table, so we skip the
                // state write rather than re-throwing in the catch.
                try {
                    const t = resolveTable(tableCfg, this.pageSize)
                    await this.recordState({
                        ds,
                        table: t,
                        cursorValue: null,
                        rowsPulled: 0,
                        error: message,
                    })
                } catch {
                    /* identifier validation failed - cannot record state */
                }
                perTable.push({
                    table: tableCfg.table,
                    rowsPulled: 0,
                    cursorBefore: null,
                    cursorAfter: null,
                    morePagesAvailable: false,
                    error: message,
                })
            }
        }

        return {
            sourceId: this.sourceId,
            startedAt,
            finishedAt: new Date().toISOString(),
            perTable,
        }
    }

    private async replicateTable(args: {
        tableCfg: ReplicationTableConfig
        ds: DataSource
        cfg?: StarbaseDBConfiguration
        source: ExternalDatabaseSource
    }): Promise<ReplicationTableResult> {
        const { tableCfg, ds, cfg, source } = args
        const t = resolveTable(tableCfg, this.pageSize)

        const cursorBefore = await this.readCursor(ds, t.destTable)
        const sql = buildSelect(t, cursorBefore !== null)
        const params = cursorBefore !== null ? [cursorBefore] : []

        const externalDataSource: DataSource = {
            ...ds,
            source: 'external',
            external: source,
        }

        const externalConfig: StarbaseDBConfiguration = {
            ...(cfg ?? { role: 'admin' as const }),
            outerbaseApiKey: this.outerbaseApiKey ?? cfg?.outerbaseApiKey,
        }

        const rowsRaw = (await executeExternalQuery({
            sql,
            params,
            dataSource: externalDataSource,
            config: externalConfig,
        })) as Record<string, unknown>[] | undefined

        const rows = Array.isArray(rowsRaw) ? rowsRaw : []
        const morePagesAvailable = rows.length >= t.pageSize

        if (rows.length === 0) {
            await this.recordState({
                ds,
                table: t,
                cursorValue: cursorBefore,
                rowsPulled: 0,
            })
            return {
                table: tableCfg.table,
                rowsPulled: 0,
                cursorBefore,
                cursorAfter: cursorBefore,
                morePagesAvailable: false,
            }
        }

        const canonicalColumns = t.columns ?? Object.keys(rows[0])
        const upsertSql = buildUpsert(t, canonicalColumns)

        let cursorAfter = cursorBefore
        for (const row of rows) {
            const { values } = rowToColumnsAndValues(row, canonicalColumns)
            await ds.rpc.executeQuery({ sql: upsertSql, params: values })
            const next = pickCursor(row, t.cursorColumn)
            if (next !== null) cursorAfter = next
        }

        await this.recordState({
            ds,
            table: t,
            cursorValue: cursorAfter,
            rowsPulled: rows.length,
        })

        return {
            table: tableCfg.table,
            rowsPulled: rows.length,
            cursorBefore,
            cursorAfter,
            morePagesAvailable,
        }
    }

    private async readCursor(
        ds: DataSource,
        destTable: string
    ): Promise<string | null> {
        const rows = (await ds.rpc.executeQuery({
            sql: SQL.GET_CURSOR,
            params: [this.sourceId, destTable],
        })) as unknown as { cursor_value: unknown }[] | undefined
        if (!rows || rows.length === 0) return null
        const v = rows[0]?.cursor_value
        if (v === undefined || v === null) return null
        return String(v)
    }

    private async recordState(args: {
        ds: DataSource
        table: ResolvedTable
        cursorValue: string | null
        rowsPulled: number
        error?: string | null
    }): Promise<void> {
        const { ds, table, cursorValue, rowsPulled } = args
        await ds.rpc.executeQuery({
            sql: SQL.UPSERT_STATE,
            params: [
                this.sourceId,
                table.destTable,
                table.cursorColumn,
                cursorValue,
                Date.now(),
                rowsPulled,
                args.error ?? null,
            ],
        })
    }
}
