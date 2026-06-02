import { StarbaseApp, StarbaseDBConfiguration } from '../../src/handler'
import { StarbasePlugin } from '../../src/plugin'
import { DataSource } from '../../src/types'
import { executeExternalQuery } from '../../src/operation'
import { executeOperation } from '../../src/export'

/**
 * Configuration for a single table to replicate from the external data source
 * into the internal (Durable Object) SQLite database.
 */
export interface ReplicationTableConfig {
    /** Table name. Must exist on the external source and in the internal DB. */
    name: string
    /**
     * Optional monotonically-increasing column (e.g. `updated_at`, `id`) used to
     * pull only NEW/CHANGED rows since the last run. When omitted, the whole
     * table is re-pulled every run (full snapshot).
     */
    cursorColumn?: string
    /** Max rows pulled per run (large tables drain across runs). Default 5000. */
    batchSize?: number
}

export interface ExternalReplicationOptions {
    tables?: ReplicationTableConfig[]
}

export interface ReplicationResult {
    table: string
    rowsReplicated: number
    cursor: string | number | null
}

/** Internal bookkeeping table that remembers the last replicated cursor per table. */
export const REPLICATION_STATE_TABLE = '_starbasedb_replication_state'

/**
 * ExternalReplicationPlugin
 *
 * Pulls data from the instance's configured EXTERNAL data source (e.g. a Postgres
 * on Supabase) into the INTERNAL Durable-Object SQLite database, so a StarbaseDB
 * instance can serve as a close-to-edge read replica that can be queried instead
 * of round-tripping to the external database.
 *
 * Design (per the maintainer's notes on the issue):
 *  - PULL based — the external source needs no changes / no per-provider push.
 *  - Per-table configuration; optional INCREMENTAL pulls via a `cursorColumn`.
 *  - Idempotent `INSERT OR REPLACE` upserts so re-runs and retries are safe.
 *  - Batched (`batchSize`) so very large tables drain across successive runs.
 *  - Exposes `POST /replicate` (all tables) and `POST /replicate/:table`. Invoke
 *    manually, or on an interval via a Cloudflare Cron Trigger (see README).
 */
export class ExternalReplicationPlugin extends StarbasePlugin {
    public prefix: string = '/replicate'
    public tables: ReplicationTableConfig[]

    constructor(opts?: ExternalReplicationOptions) {
        super('starbasedb:external-replication', { requiresAuth: true })
        this.tables = opts?.tables ?? []
    }

    override async register(app: StarbaseApp) {
        // Replicate every configured table. Admin only.
        app.post(this.prefix, async (c) => {
            const config = c.get('config') as StarbaseDBConfiguration
            const dataSource = c.get('dataSource') as DataSource

            if (config?.role !== 'admin') {
                return c.json({ error: 'Unauthorized request' }, 401)
            }

            const tables = await this.replicateAll(dataSource, config)
            return c.json({ success: true, tables })
        })

        // Replicate a single configured table by name.
        app.post(`${this.prefix}/:table`, async (c) => {
            const config = c.get('config') as StarbaseDBConfiguration
            const dataSource = c.get('dataSource') as DataSource

            if (config?.role !== 'admin') {
                return c.json({ error: 'Unauthorized request' }, 401)
            }

            const name = c.req.param('table')
            const table = this.tables.find((t) => t.name === name)
            if (!table) {
                return c.json(
                    {
                        error: `Table '${name}' is not configured for replication`,
                    },
                    404
                )
            }

            const result = await this.replicateTable(table, dataSource, config)
            return c.json({ success: true, ...result })
        })
    }

    /** Replicate all configured tables sequentially, returning a per-table summary. */
    async replicateAll(
        dataSource: DataSource,
        config: StarbaseDBConfiguration
    ): Promise<ReplicationResult[]> {
        const results: ReplicationResult[] = []
        for (const table of this.tables) {
            results.push(await this.replicateTable(table, dataSource, config))
        }
        return results
    }

    /**
     * Replicate one table: pull a batch of new rows from the external source,
     * upsert them into the internal database, then advance the saved cursor.
     */
    async replicateTable(
        table: ReplicationTableConfig,
        dataSource: DataSource,
        config: StarbaseDBConfiguration
    ): Promise<ReplicationResult> {
        const externalDataSource: DataSource = {
            ...dataSource,
            source: 'external',
        }
        const internalDataSource: DataSource = {
            ...dataSource,
            source: 'internal',
            external: undefined,
        }

        await this.ensureStateTable(internalDataSource, config)
        const lastCursor = await this.getLastCursor(
            table.name,
            internalDataSource,
            config
        )

        // 1. Pull a batch of new/changed rows from the external source.
        const { sql, params } = this.buildSelectQuery(table, lastCursor)
        const rows: Record<string, unknown>[] = await executeExternalQuery({
            sql,
            params,
            dataSource: externalDataSource,
            config,
        })

        if (!rows || rows.length === 0) {
            return { table: table.name, rowsReplicated: 0, cursor: lastCursor }
        }

        // 2. Upsert the rows into the internal database in a single transaction.
        const writes = this.buildUpsertQueries(table.name, rows)
        await executeOperation(writes, internalDataSource, config)

        // 3. Advance + persist the cursor (only for incremental tables).
        let cursor = lastCursor
        if (table.cursorColumn) {
            cursor = rows[rows.length - 1][table.cursorColumn] as
                | string
                | number
                | null
            await this.setLastCursor(
                table.name,
                cursor,
                internalDataSource,
                config
            )
        }

        return { table: table.name, rowsReplicated: rows.length, cursor }
    }

    /** Build the incremental SELECT against the external source. Pure + unit-testable. */
    buildSelectQuery(
        table: ReplicationTableConfig,
        lastCursor: string | number | null
    ): { sql: string; params: unknown[] } {
        const limit = table.batchSize ?? 5000
        const params: unknown[] = []
        let sql = `SELECT * FROM ${quoteIdent(table.name)}`

        if (
            table.cursorColumn &&
            lastCursor !== null &&
            lastCursor !== undefined
        ) {
            sql += ` WHERE ${quoteIdent(table.cursorColumn)} > ?`
            params.push(lastCursor)
        }
        if (table.cursorColumn) {
            sql += ` ORDER BY ${quoteIdent(table.cursorColumn)} ASC`
        }
        sql += ` LIMIT ${limit}`

        return { sql, params }
    }

    /** Build idempotent INSERT-OR-REPLACE writes for the internal DB. Pure + unit-testable. */
    buildUpsertQueries(
        tableName: string,
        rows: Record<string, unknown>[]
    ): { sql: string; params: unknown[] }[] {
        return rows.map((row) => {
            const columns = Object.keys(row)
            const placeholders = columns.map(() => '?').join(', ')
            const columnList = columns.map(quoteIdent).join(', ')
            return {
                sql: `INSERT OR REPLACE INTO ${quoteIdent(tableName)} (${columnList}) VALUES (${placeholders})`,
                params: columns.map((col) => row[col]),
            }
        })
    }

    private async ensureStateTable(
        internalDataSource: DataSource,
        config: StarbaseDBConfiguration
    ) {
        await executeOperation(
            [
                {
                    sql: `CREATE TABLE IF NOT EXISTS ${REPLICATION_STATE_TABLE} (table_name TEXT PRIMARY KEY, last_cursor TEXT, last_synced_at TEXT)`,
                },
            ],
            internalDataSource,
            config
        )
    }

    private async getLastCursor(
        tableName: string,
        internalDataSource: DataSource,
        config: StarbaseDBConfiguration
    ): Promise<string | number | null> {
        const result = await executeOperation(
            [
                {
                    sql: `SELECT last_cursor FROM ${REPLICATION_STATE_TABLE} WHERE table_name = ?`,
                    params: [tableName],
                },
            ],
            internalDataSource,
            config
        )

        const rows = (Array.isArray(result) ? result.flat() : []) as {
            last_cursor?: string | number | null
        }[]
        return rows[0]?.last_cursor ?? null
    }

    private async setLastCursor(
        tableName: string,
        cursor: string | number | null,
        internalDataSource: DataSource,
        config: StarbaseDBConfiguration
    ) {
        await executeOperation(
            [
                {
                    sql: `INSERT OR REPLACE INTO ${REPLICATION_STATE_TABLE} (table_name, last_cursor, last_synced_at) VALUES (?, ?, ?)`,
                    params: [
                        tableName,
                        cursor === null ? null : String(cursor),
                        new Date().toISOString(),
                    ],
                },
            ],
            internalDataSource,
            config
        )
    }
}

/** Quote a SQL identifier (table/column) defensively. */
function quoteIdent(name: string): string {
    return '"' + String(name).replace(/"/g, '""') + '"'
}
