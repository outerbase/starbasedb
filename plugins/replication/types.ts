/**
 * Public types for the StarbaseDB replication plugin.
 *
 * The plugin pulls rows from an external relational source (Postgres, MySQL,
 * or any user-provided adapter) into the internal Durable Object SQLite, on a
 * configurable per-table interval, advancing a per-table watermark on every
 * successful run.
 */

export type SqlScalar = string | number | boolean | null | bigint | Date

export interface ColumnDef {
    /** Column name as it should appear in SQLite. */
    name: string
    /**
     * SQLite affinity for the column ("TEXT", "INTEGER", "REAL", "BLOB",
     * "NUMERIC"). Adapters are expected to translate their dialect's native
     * types to one of these.
     */
    sqliteType: 'TEXT' | 'INTEGER' | 'REAL' | 'BLOB' | 'NUMERIC'
    /** Whether the column is part of the primary key. */
    primaryKey?: boolean
}

export interface PullPage {
    rows: Record<string, SqlScalar>[]
    /**
     * The watermark value that should be persisted after this page is written.
     * Adapters MUST return a watermark that is monotonically non-decreasing
     * for a given (table, watermarkColumn).
     */
    nextWatermark: SqlScalar | null
}

export interface ReplicationAdapter {
    /**
     * Reflect the external table's schema. Called once per table, on the
     * first sync, to provision a matching SQLite table in the DO.
     */
    describe(table: string): Promise<ColumnDef[]>

    /**
     * Pull rows whose `watermarkColumn` is strictly greater than `watermark`
     * (or all rows if `watermark` is null), ordered ascending by
     * `watermarkColumn`. Implementations may yield multiple pages; the plugin
     * advances the watermark after every page.
     *
     * Implementations should respect `pageSize` as an upper bound on rows per
     * page so a single sync run cannot OOM the worker.
     */
    pull(opts: {
        table: string
        watermarkColumn: string
        watermark: SqlScalar | null
        pageSize: number
    }): AsyncIterable<PullPage>

    /** Release any pooled resources. Called once when the plugin shuts down. */
    close(): Promise<void>
}

export interface TableConfig {
    /** Source-side table name. */
    name: string
    /** Column the plugin compares to advance the watermark. */
    watermark: string
    /**
     * Optional primary key column(s) used to upsert rows in SQLite. If
     * omitted, rows are appended (suitable for append-only logs keyed on the
     * watermark column).
     */
    primaryKey?: string | string[]
    /** Optional override for the SQLite table name. Defaults to `name`. */
    target?: string
}

export interface ReplicationSourceConfig {
    /** Adapter type. `postgres`, `mysql`, or `mock` (for tests). */
    source: 'postgres' | 'mysql' | 'mock'
    /** Connection string consumed by the adapter. */
    conn?: string
    /**
     * How often this source should be pulled, in seconds. Each table inherits
     * this interval unless overridden.
     */
    intervalSeconds: number
    /** Tables to replicate from this source. */
    tables: TableConfig[]
    /** Override the page size for this source (default 1000). */
    pageSize?: number
}

export type ReplicationConfig = ReplicationSourceConfig[]
