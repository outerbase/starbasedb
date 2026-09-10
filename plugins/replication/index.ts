import { StarbaseApp, StarbaseDBConfiguration } from '../../src/handler'
import { executeQuery } from '../../src/operation'
import { StarbasePlugin } from '../../src/plugin'
import { DataSource } from '../../src/types'
import { createResponse } from '../../src/utils'
import {
    assertPositiveInteger,
    buildCreateTableQuery,
    buildSelectQuery,
    buildUpsertQuery,
    nextCheckpointValue,
    normalizeTables,
    NormalizedReplicationTable,
    ReplicationConfigurationError,
    ReplicationTable,
    rewriteQuerySchemaPrefixes,
} from './utils'

const SQL_QUERIES = {
    CREATE_CHECKPOINT_TABLE: `
        CREATE TABLE IF NOT EXISTS tmp_replication_checkpoints (
            table_name TEXT NOT NULL PRIMARY KEY,
            last_value TEXT,
            updated_at INTEGER
        )
    `,
    GET_CHECKPOINT: `
        SELECT last_value FROM tmp_replication_checkpoints WHERE table_name = ?
    `,
    GET_ALL_CHECKPOINTS: `
        SELECT table_name, last_value, updated_at FROM tmp_replication_checkpoints
    `,
    SET_CHECKPOINT: `
        INSERT OR REPLACE INTO tmp_replication_checkpoints (table_name, last_value, updated_at)
        VALUES (?, ?, ?)
    `,
    LAST_PULLED_AT: `
        SELECT MAX(updated_at) AS last_pulled_at FROM tmp_replication_checkpoints
    `,
}

const DEFAULT_INTERVAL_SECONDS = 300
const DEFAULT_BATCH_SIZE = 1000

/** Outcome of replicating a single table during a pull. */
export interface ReplicationResult {
    table: string
    rowsReplicated: number
}

/** A function that reads rows from the external data source. Injectable for testing. */
export type ExternalReader = (
    sql: string,
    params: unknown[]
) => Promise<Record<string, unknown>[]>

export interface ReplicationPluginOptions {
    /** Tables to pull from the external source into the internal DO SQLite. */
    tables: ReplicationTable[]
    /**
     * How often (in seconds) the plugin will automatically pull when requests come
     * in. Set to `0` to disable automatic pulling and only pull on demand via
     * `pull()` or the `/replication/pull` endpoint. Defaults to 300 (5 minutes).
     */
    intervalSeconds?: number
    /** Maximum number of rows fetched per table per pull. Defaults to 1000. */
    batchSize?: number
    /**
     * Optional override for reading from the external source. Defaults to querying
     * the configured external data source. Primarily useful for testing or custom
     * source connectors.
     */
    readExternal?: ExternalReader
}

/**
 * Pulls data from an external data source into the internal Durable Object SQLite
 * database so the instance can serve as a close-to-edge replica. Replication is
 * append-only: each table tracks the highest value seen for a user-defined column
 * (e.g. `id` or `created_at`) and only fetches newer rows on subsequent pulls.
 */
export class ReplicationPlugin extends StarbasePlugin {
    public pathPrefix: string = '/replication'
    private dataSource?: DataSource
    private config?: StarbaseDBConfiguration
    private executionContext?: ExecutionContext
    private readonly tables: NormalizedReplicationTable[]
    private readonly intervalMs: number
    private readonly batchSize: number
    private readonly externalReader?: ExternalReader
    private isPulling = false

    constructor(options: ReplicationPluginOptions) {
        super('starbasedb:replication', {
            requiresAuth: true,
        })

        this.tables = normalizeTables(options.tables)

        const intervalSeconds =
            options.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS
        if (intervalSeconds !== 0) {
            assertPositiveInteger(intervalSeconds, 'intervalSeconds')
        }
        this.intervalMs = intervalSeconds * 1000

        this.batchSize = assertPositiveInteger(
            options.batchSize ?? DEFAULT_BATCH_SIZE,
            'batchSize'
        )

        this.externalReader = options.readExternal
    }

    override async register(app: StarbaseApp) {
        app.use(async (c, next) => {
            this.dataSource = c?.get('dataSource')
            this.config = c?.get('config')
            // `executionCtx` getter throws when no ExecutionContext is bound (e.g.
            // outside a Workers fetch handler), so access it defensively.
            try {
                this.executionContext = c?.executionCtx as any
            } catch {
                this.executionContext = undefined
            }
            await this.init()
            await this.maybeAutoPull()
            await next()
        })

        // Manually trigger a replication pull. Restricted to admin users.
        app.post(`${this.pathPrefix}/pull`, async (c) => {
            if (this.config?.role !== 'admin') {
                return createResponse(undefined, 'Unauthorized request', 401)
            }

            const replicated = await this.pull()
            return createResponse({ success: true, replicated }, undefined, 200)
        })

        // Retrieve current replication status and checkpoints. Restricted to admin users.
        app.get(`${this.pathPrefix}/status`, async (c) => {
            if (this.config?.role !== 'admin') {
                return createResponse(undefined, 'Unauthorized request', 401)
            }

            const status = await this.getStatus()
            return createResponse({ success: true, ...status }, undefined, 200)
        })
    }

    override async beforeQuery(opts: {
        sql: string
        params?: unknown[]
        dataSource?: DataSource
        config?: StarbaseDBConfiguration
    }): Promise<{ sql: string; params?: unknown[] }> {
        // When querying internal DO SQLite, rewrite qualified schema prefixes
        // (e.g. `public.users` -> `users`) for transparent compatibility.
        if (!opts.dataSource || opts.dataSource.source === 'internal') {
            const rewrittenSql = rewriteQuerySchemaPrefixes(opts.sql, this.tables)
            return {
                sql: rewrittenSql,
                params: opts.params,
            }
        }
        return {
            sql: opts.sql,
            params: opts.params,
        }
    }

    private async init() {
        if (!this.dataSource) return

        await this.dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.CREATE_CHECKPOINT_TABLE,
            params: [],
        })
    }

    /**
     * Trigger a pull in the background when the configured interval has elapsed since
     * the last successful pull. Cloudflare Workers cannot run free-standing timers, so
     * the interval is evaluated lazily on incoming requests and the work is detached
     * via `waitUntil` so query latency is unaffected.
     */
    private async maybeAutoPull() {
        if (!this.dataSource || this.intervalMs === 0 || this.isPulling) {
            return
        }

        const result = (await this.dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.LAST_PULLED_AT,
            params: [],
        })) as unknown as { last_pulled_at: number | null }[]

        const lastPulledAt = result?.[0]?.last_pulled_at ?? 0
        if (Date.now() - lastPulledAt < this.intervalMs) {
            return
        }

        const pullPromise = this.pull().catch((error) => {
            console.error('Replication auto-pull failed:', error)
        })

        if (this.executionContext) {
            this.executionContext.waitUntil(pullPromise)
        } else {
            await pullPromise
        }
    }

    /**
     * Pull newer rows for every configured table from the external source into the
     * internal database. Returns the number of rows replicated per table.
     */
    public async pull(): Promise<ReplicationResult[]> {
        if (!this.dataSource) {
            throw new Error('ReplicationPlugin not properly initialized')
        }

        if (this.isPulling) {
            return []
        }

        this.isPulling = true
        try {
            const results: ReplicationResult[] = []
            for (const table of this.tables) {
                results.push(await this.replicateTable(table))
            }
            return results
        } finally {
            this.isPulling = false
        }
    }

    private async replicateTable(
        table: NormalizedReplicationTable
    ): Promise<ReplicationResult> {
        const lastValue = await this.getCheckpoint(table.destinationTable)
        const { sql, params } = buildSelectQuery(
            table,
            lastValue,
            this.batchSize
        )
        const rows = await this.readExternal(sql, params)

        if (!rows.length) {
            return { table: table.destinationTable, rowsReplicated: 0 }
        }

        // Auto-create destination table in internal SQLite if it does not exist yet
        const columns = Object.keys(rows[0])
        const createTableSql = buildCreateTableQuery(
            table.destinationTable,
            columns,
            table.trackBy
        )
        await this.dataSource!.rpc.executeQuery({
            sql: createTableSql,
            params: [],
        })

        for (const row of rows) {
            const upsert = buildUpsertQuery(table.destinationTable, row)
            await this.dataSource!.rpc.executeQuery({
                sql: upsert.sql,
                params: upsert.params,
            })
        }

        await this.setCheckpoint(
            table.destinationTable,
            nextCheckpointValue(rows, table.trackBy)
        )

        return { table: table.destinationTable, rowsReplicated: rows.length }
    }

    private async readExternal(
        sql: string,
        params: unknown[]
    ): Promise<Record<string, unknown>[]> {
        if (this.externalReader) {
            return this.externalReader(sql, params)
        }

        if (!this.dataSource?.external || !this.config) {
            throw new Error(
                'No external data source configured for replication.'
            )
        }

        // Hyperdrive connections are identified by a connection string, every other
        // external source is queried through the standard external code path.
        const source =
            'connectionString' in this.dataSource.external
                ? 'hyperdrive'
                : 'external'

        const result = await executeQuery({
            sql,
            params,
            isRaw: false,
            dataSource: { ...this.dataSource, source },
            config: this.config,
        })

        return (result as Record<string, unknown>[]) ?? []
    }

    private async getCheckpoint(destinationTable: string): Promise<unknown> {
        const result = (await this.dataSource!.rpc.executeQuery({
            sql: SQL_QUERIES.GET_CHECKPOINT,
            params: [destinationTable],
        })) as unknown as { last_value: string | null }[]

        const stored = result?.[0]?.last_value
        if (stored === undefined || stored === null) {
            return null
        }

        // Stored as JSON so the original type (number vs string) is preserved for the
        // source comparison — comparing a numeric `id` against a quoted string breaks
        // on strongly typed engines like Postgres.
        try {
            return JSON.parse(stored)
        } catch {
            return stored
        }
    }

    private async setCheckpoint(destinationTable: string, value: unknown) {
        await this.dataSource!.rpc.executeQuery({
            sql: SQL_QUERIES.SET_CHECKPOINT,
            params: [
                destinationTable,
                JSON.stringify(value ?? null),
                Date.now(),
            ],
        })
    }

    public async getStatus(): Promise<{
        checkpoints: { table_name: string; last_value: unknown; updated_at: number }[]
        lastPulledAt: number | null
    }> {
        if (!this.dataSource) {
            return { checkpoints: [], lastPulledAt: null }
        }

        const rawCheckpoints = (await this.dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.GET_ALL_CHECKPOINTS,
            params: [],
        })) as unknown as { table_name: string; last_value: string | null; updated_at: number }[]

        const checkpoints = (rawCheckpoints || []).map((cp) => {
            let lastValue: unknown = cp.last_value
            try {
                if (cp.last_value !== null && cp.last_value !== undefined) {
                    lastValue = JSON.parse(cp.last_value)
                }
            } catch {
                lastValue = cp.last_value
            }
            return {
                table_name: cp.table_name,
                last_value: lastValue,
                updated_at: cp.updated_at,
            }
        })

        const lastResult = (await this.dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.LAST_PULLED_AT,
            params: [],
        })) as unknown as { last_pulled_at: number | null }[]

        return {
            checkpoints,
            lastPulledAt: lastResult?.[0]?.last_pulled_at ?? null,
        }
    }
}

// Re-exported so consumers can catch configuration errors and reuse the types.
export { ReplicationConfigurationError }
export type { ReplicationTable }
