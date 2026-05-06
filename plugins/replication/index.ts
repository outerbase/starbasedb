import { StarbaseApp } from '../../src/handler'
import { StarbasePlugin } from '../../src/plugin'
import { DataSource, QueryResult } from '../../src/types'
import { createResponse } from '../../src/utils'

import { MysqlAdapter } from './adapters/mysql'
import { PostgresAdapter } from './adapters/postgres'
import {
    CREATE_LOG_TABLE,
    CREATE_WATERMARK_TABLE,
    INSERT_LOG,
    SELECT_WATERMARK,
    UPSERT_WATERMARK,
    buildCreateTable,
    buildInsert,
} from './sql'
import type {
    ReplicationAdapter,
    ReplicationConfig,
    ReplicationSourceConfig,
    SqlScalar,
    TableConfig,
} from './types'

export type { ReplicationAdapter, ReplicationConfig } from './types'

export interface ReplicationPluginOptions {
    /**
     * Replication configuration. If omitted the plugin will read
     * `REPLICATION_CONFIG_JSON` from the environment passed in via
     * `env`. Both forms are supported so users can pick whatever fits
     * their wrangler setup.
     */
    config?: ReplicationConfig
    /** Optional env-style record from which to pull `REPLICATION_CONFIG_JSON`. */
    env?: { REPLICATION_CONFIG_JSON?: string }
    /**
     * Adapter factory override. Useful for tests and for plugging in
     * adapters this package doesn't ship (e.g. SQL Server, ClickHouse).
     * If supplied it takes precedence over the built-in postgres/mysql
     * adapters.
     */
    adapterFactory?: (source: ReplicationSourceConfig) => ReplicationAdapter
}

interface ScheduledTable {
    source: ReplicationSourceConfig
    table: TableConfig
    nextRunAt: number
    schemaInitialized: boolean
}

/**
 * Pulls rows from external relational databases into the StarbaseDB-managed
 * SQLite Durable Object on a configurable per-table interval. The plugin is
 * intentionally small: it does not expose an admin REST API, it does not
 * manage push or bidirectional replication, and it does not introduce a new
 * scheduling primitive — it leans on the existing DO alarm via the same
 * pattern the CronPlugin uses.
 */
export class ReplicationPlugin extends StarbasePlugin {
    public pathPrefix = '/replication'

    private dataSource?: DataSource
    private adapters = new Map<number, ReplicationAdapter>()
    private schedule: ScheduledTable[] = []
    private readonly config: ReplicationConfig
    private readonly adapterFactory?: (
        source: ReplicationSourceConfig
    ) => ReplicationAdapter
    private initialized = false

    constructor(opts: ReplicationPluginOptions = {}) {
        super('starbasedb:replication', { requiresAuth: true })

        this.adapterFactory = opts.adapterFactory

        if (opts.config) {
            this.config = opts.config
        } else {
            const raw = opts.env?.REPLICATION_CONFIG_JSON
            this.config = raw ? parseConfig(raw) : []
        }

        this.schedule = this.config.flatMap((source) =>
            source.tables.map((table) => ({
                source,
                table,
                nextRunAt: 0,
                schemaInitialized: false,
            }))
        )
    }

    override async register(app: StarbaseApp) {
        app.use(async (c, next) => {
            this.dataSource = c?.get('dataSource')
            await this.init()
            await next()
        })

        // Manual trigger — admins can poke this to force a sync without
        // waiting for the next interval. This is the only HTTP surface the
        // plugin exposes; configuration lives entirely in env vars.
        app.post(`${this.pathPrefix}/run`, async (c) => {
            const config = c.get('config')
            if (config?.role !== 'admin') {
                return createResponse(undefined, 'Unauthorized', 401)
            }

            const ds = c.get('dataSource')
            const summary = await this.runDue(ds, { force: true })
            return createResponse(summary, undefined, 200)
        })

        // Status endpoint so users can see what's been pulled. Single
        // read-only handler rather than a full CRUD admin API.
        app.get(`${this.pathPrefix}/status`, async (c) => {
            const config = c.get('config')
            if (config?.role !== 'admin') {
                return createResponse(undefined, 'Unauthorized', 401)
            }
            const ds = c.get('dataSource')
            const watermarks = (await ds.rpc.executeQuery({
                sql: `SELECT source, "table", watermark_column, last_value, last_run_ts FROM _starbase_replication_watermarks`,
                params: [],
            })) as QueryResult[]
            return createResponse({ watermarks }, undefined, 200)
        })
    }

    private async init() {
        if (this.initialized || !this.dataSource) return
        await this.dataSource.rpc.executeQuery({
            sql: CREATE_WATERMARK_TABLE,
            params: [],
        })
        await this.dataSource.rpc.executeQuery({
            sql: CREATE_LOG_TABLE,
            params: [],
        })
        this.initialized = true
    }

    /**
     * Public entry point used by the scheduled handler in `src/index.ts`. The
     * caller supplies the live DataSource (it isn't available at construction
     * time) and the plugin runs every table whose interval has elapsed.
     *
     * Returns a summary so the scheduled() handler can be observed in the
     * Cloudflare logs.
     */
    public async runDue(
        dataSource: DataSource,
        opts: { force?: boolean; now?: number } = {}
    ): Promise<
        {
            source: string
            table: string
            rows: number
            ok: boolean
            error?: string
        }[]
    > {
        this.dataSource = dataSource
        await this.init()

        const now = opts.now ?? Date.now()
        const summary: {
            source: string
            table: string
            rows: number
            ok: boolean
            error?: string
        }[] = []

        for (const slot of this.schedule) {
            if (!opts.force && slot.nextRunAt > now) continue
            try {
                const rows = await this.runOne(slot, now)
                summary.push({
                    source: slot.source.source,
                    table: slot.table.name,
                    rows,
                    ok: true,
                })
                slot.nextRunAt = now + slot.source.intervalSeconds * 1000
                await this.log(slot, now, rows, true)
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e)
                summary.push({
                    source: slot.source.source,
                    table: slot.table.name,
                    rows: 0,
                    ok: false,
                    error: msg,
                })
                // Back off this table by its interval so a broken source
                // doesn't busy-loop the worker, but still let other tables
                // continue this tick.
                slot.nextRunAt = now + slot.source.intervalSeconds * 1000
                await this.log(slot, now, 0, false, msg)
            }
        }

        return summary
    }

    private async runOne(slot: ScheduledTable, now: number): Promise<number> {
        if (!this.dataSource) throw new Error('replication: no dataSource')

        const ds = this.dataSource
        const adapter = this.getAdapter(slot.source)
        const targetTable = slot.table.target ?? slot.table.name

        // Materialise the SQLite table if it's the first sync.
        if (!slot.schemaInitialized) {
            const cols = await adapter.describe(slot.table.name)
            // Adapter-reflected primary key is overridden by config if
            // supplied so users can replicate non-PK tables with a custom
            // dedup column.
            const pkOverride = normalisePk(slot.table.primaryKey)
            const finalCols = pkOverride
                ? cols.map((c) => ({
                      ...c,
                      primaryKey: pkOverride.includes(c.name),
                  }))
                : cols
            await ds.rpc.executeQuery({
                sql: buildCreateTable(targetTable, finalCols),
                params: [],
            })
            slot.schemaInitialized = true
        }

        // Read prior watermark.
        const wmRows = (await ds.rpc.executeQuery({
            sql: SELECT_WATERMARK,
            params: [slot.source.source, slot.table.name],
        })) as unknown as { last_value: string | null }[]

        let watermark: SqlScalar | null =
            wmRows.length > 0 ? wmRows[0].last_value : null

        const pageSize = slot.source.pageSize ?? 1000
        let pulled = 0

        for await (const page of adapter.pull({
            table: slot.table.name,
            watermarkColumn: slot.table.watermark,
            watermark,
            pageSize,
        })) {
            if (page.rows.length === 0) continue

            const colNames = Object.keys(page.rows[0])
            const insertSql = buildInsert(
                targetTable,
                colNames,
                Boolean(slot.table.primaryKey)
            )

            for (const row of page.rows) {
                const params = colNames.map((c) => normaliseScalar(row[c]))
                await ds.rpc.executeQuery({ sql: insertSql, params })
            }

            pulled += page.rows.length
            watermark = page.nextWatermark

            // Persist progress after every page so a mid-run failure on the
            // next page doesn't redo work.
            await ds.rpc.executeQuery({
                sql: UPSERT_WATERMARK,
                params: [
                    slot.source.source,
                    slot.table.name,
                    slot.table.watermark,
                    serialiseWatermark(watermark),
                    now,
                ],
            })
        }

        if (pulled === 0) {
            // Still record the run so users can see liveness.
            await ds.rpc.executeQuery({
                sql: UPSERT_WATERMARK,
                params: [
                    slot.source.source,
                    slot.table.name,
                    slot.table.watermark,
                    serialiseWatermark(watermark),
                    now,
                ],
            })
        }

        return pulled
    }

    private async log(
        slot: ScheduledTable,
        now: number,
        rows: number,
        ok: boolean,
        error?: string
    ) {
        if (!this.dataSource) return
        await this.dataSource.rpc.executeQuery({
            sql: INSERT_LOG,
            params: [
                now,
                slot.source.source,
                slot.table.name,
                rows,
                ok ? 1 : 0,
                error ?? null,
            ],
        })
    }

    private getAdapter(source: ReplicationSourceConfig): ReplicationAdapter {
        const idx = this.config.indexOf(source)
        const cached = this.adapters.get(idx)
        if (cached) return cached

        const built = this.adapterFactory
            ? this.adapterFactory(source)
            : defaultAdapterFactory(source)
        this.adapters.set(idx, built)
        return built
    }

    /** Release pooled adapter connections. Call on Worker shutdown. */
    public async close() {
        for (const a of this.adapters.values()) {
            try {
                await a.close()
            } catch (e) {
                console.error('replication: adapter close failed', e)
            }
        }
        this.adapters.clear()
    }
}

function defaultAdapterFactory(
    source: ReplicationSourceConfig
): ReplicationAdapter {
    if (source.source === 'postgres') {
        if (!source.conn)
            throw new Error('replication: postgres source missing `conn`')
        return new PostgresAdapter(source.conn)
    }
    if (source.source === 'mysql') {
        if (!source.conn)
            throw new Error('replication: mysql source missing `conn`')
        return new MysqlAdapter(source.conn)
    }
    throw new Error(
        `replication: no built-in adapter for source type "${source.source}". Provide adapterFactory.`
    )
}

function parseConfig(raw: string): ReplicationConfig {
    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch (e) {
        throw new Error(
            `replication: REPLICATION_CONFIG_JSON is not valid JSON: ${
                e instanceof Error ? e.message : e
            }`
        )
    }
    if (!Array.isArray(parsed)) {
        throw new Error(
            'replication: REPLICATION_CONFIG_JSON must be a JSON array of source configs'
        )
    }
    return parsed.map((src, i) => validateSource(src, i))
}

function validateSource(src: unknown, i: number): ReplicationSourceConfig {
    if (!src || typeof src !== 'object')
        throw new Error(`replication: config[${i}] is not an object`)
    const s = src as Record<string, unknown>
    if (typeof s.source !== 'string')
        throw new Error(`replication: config[${i}].source must be a string`)
    if (typeof s.intervalSeconds !== 'number' || s.intervalSeconds <= 0)
        throw new Error(
            `replication: config[${i}].intervalSeconds must be a positive number`
        )
    if (!Array.isArray(s.tables) || s.tables.length === 0)
        throw new Error(
            `replication: config[${i}].tables must be a non-empty array`
        )
    return {
        source: s.source as ReplicationSourceConfig['source'],
        conn: typeof s.conn === 'string' ? s.conn : undefined,
        intervalSeconds: s.intervalSeconds,
        pageSize: typeof s.pageSize === 'number' ? s.pageSize : undefined,
        tables: (s.tables as unknown[]).map((t, j) => validateTable(t, i, j)),
    }
}

function validateTable(t: unknown, i: number, j: number): TableConfig {
    if (!t || typeof t !== 'object')
        throw new Error(
            `replication: config[${i}].tables[${j}] is not an object`
        )
    const r = t as Record<string, unknown>
    if (typeof r.name !== 'string')
        throw new Error(
            `replication: config[${i}].tables[${j}].name must be a string`
        )
    if (typeof r.watermark !== 'string')
        throw new Error(
            `replication: config[${i}].tables[${j}].watermark must be a string`
        )
    return {
        name: r.name,
        watermark: r.watermark,
        primaryKey:
            typeof r.primaryKey === 'string'
                ? r.primaryKey
                : Array.isArray(r.primaryKey)
                  ? (r.primaryKey as string[])
                  : undefined,
        target: typeof r.target === 'string' ? r.target : undefined,
    }
}

function normalisePk(pk: TableConfig['primaryKey']): string[] | null {
    if (!pk) return null
    return Array.isArray(pk) ? pk : [pk]
}

/** Convert adapter-side scalars into something the DO's executeQuery accepts. */
function normaliseScalar(v: SqlScalar | undefined): SqlScalar {
    if (v === undefined) return null
    if (v instanceof Date) return v.toISOString()
    if (typeof v === 'boolean') return v ? 1 : 0
    if (typeof v === 'bigint') {
        // SQLite INTEGER is 8 bytes so safe within bigint range, but the RPC
        // bridge is happier with strings or numbers.
        return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString()
    }
    return v
}

function serialiseWatermark(v: SqlScalar | null): string | null {
    if (v === null || v === undefined) return null
    if (v instanceof Date) return v.toISOString()
    return String(v)
}
