/**
 * A single table that should be replicated from the external data source into the
 * internal Durable Object SQLite database.
 */
export interface ReplicationTable {
    /** Table name on the external data source. */
    name: string
    /**
     * Column used for append-only polling. Must be monotonically increasing so we
     * can ask the source for "everything newer than what we already have" (e.g. an
     * auto-incrementing `id` or a `created_at` timestamp).
     */
    trackBy: string
    /** Optional schema on the external source (e.g. `public` for Postgres). */
    schema?: string
    /** Optional internal table name. Defaults to `name`. */
    destinationTable?: string
}

/** A `ReplicationTable` after defaults have been applied and validation has passed. */
export interface NormalizedReplicationTable {
    name: string
    trackBy: string
    schema?: string
    destinationTable: string
}

/** Thrown when the plugin is configured with invalid options. */
export class ReplicationConfigurationError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'ReplicationConfigurationError'
    }
}

// SQL identifiers (table/column/schema names) cannot be passed as bound parameters,
// so we validate them against a strict allow-list to avoid SQL injection when they
// are interpolated into statements.
const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

export function assertValidIdentifier(value: unknown, label: string): string {
    if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
        throw new ReplicationConfigurationError(
            `Invalid ${label}: ${JSON.stringify(value)}. Identifiers may only contain letters, numbers and underscores and may not start with a number.`
        )
    }

    return value
}

/**
 * Validate the configured tables, apply defaults and reject duplicates. Throws a
 * `ReplicationConfigurationError` on any invalid input rather than silently producing
 * a broken replication job.
 */
export function normalizeTables(
    tables: ReplicationTable[]
): NormalizedReplicationTable[] {
    if (!Array.isArray(tables) || tables.length === 0) {
        throw new ReplicationConfigurationError(
            'At least one table must be configured for replication.'
        )
    }

    const seen = new Set<string>()

    return tables.map((table) => {
        assertValidIdentifier(table?.name, 'table name')
        assertValidIdentifier(table?.trackBy, 'trackBy column')

        const destinationTable = table.destinationTable ?? table.name
        assertValidIdentifier(destinationTable, 'destinationTable')

        if (table.schema !== undefined) {
            assertValidIdentifier(table.schema, 'schema')
        }

        if (seen.has(destinationTable)) {
            throw new ReplicationConfigurationError(
                `Duplicate destination table: ${destinationTable}. Each table may only be replicated once.`
            )
        }
        seen.add(destinationTable)

        return {
            name: table.name,
            trackBy: table.trackBy,
            schema: table.schema,
            destinationTable,
        }
    })
}

export function assertPositiveInteger(value: unknown, label: string): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
        throw new ReplicationConfigurationError(
            `${label} must be a positive integer, received ${JSON.stringify(value)}.`
        )
    }

    return value
}

/**
 * Build the append-only SELECT statement that fetches rows from the external source
 * that are newer than the last checkpoint. When no checkpoint exists yet (first pull)
 * the WHERE clause is omitted so the full table is seeded.
 */
export function buildSelectQuery(
    table: NormalizedReplicationTable,
    lastValue: unknown,
    batchSize: number
): { sql: string; params: unknown[] } {
    const source = table.schema ? `${table.schema}.${table.name}` : table.name
    const params: unknown[] = []
    let sql = `SELECT * FROM ${source}`

    if (lastValue !== null && lastValue !== undefined) {
        sql += ` WHERE ${table.trackBy} > ?`
        params.push(lastValue)
    }

    sql += ` ORDER BY ${table.trackBy} ASC LIMIT ${batchSize}`

    return { sql, params }
}

/**
 * Build an `INSERT OR REPLACE` statement for a single row so re-pulling an already
 * seen row (e.g. after a partial failure) is idempotent rather than a duplicate-key
 * crash. Column names originate from the external result set, so they are validated
 * as identifiers too.
 */
export function buildUpsertQuery(
    destinationTable: string,
    row: Record<string, unknown>
): { sql: string; params: unknown[] } {
    const columns = Object.keys(row)

    if (columns.length === 0) {
        throw new ReplicationConfigurationError(
            `Cannot replicate an empty row into ${destinationTable}.`
        )
    }

    columns.forEach((column) => assertValidIdentifier(column, 'column name'))

    const placeholders = columns.map(() => '?').join(', ')
    const sql = `INSERT OR REPLACE INTO ${destinationTable} (${columns.join(', ')}) VALUES (${placeholders})`
    const params = columns.map((column) => row[column])

    return { sql, params }
}

/**
 * Determine the new checkpoint value from a batch of rows. Rows are fetched ordered
 * by `trackBy` ascending, so the last row holds the highest seen value. Returns
 * `null` for an empty batch (checkpoint should not advance).
 */
export function nextCheckpointValue(
    rows: Record<string, unknown>[],
    trackBy: string
): unknown {
    if (!rows.length) {
        return null
    }

    const lastRow = rows[rows.length - 1]

    if (!(trackBy in lastRow)) {
        throw new ReplicationConfigurationError(
            `trackBy column "${trackBy}" was not present in the replicated rows. Make sure it is selected from the source table.`
        )
    }

    return lastRow[trackBy]
}

/**
 * Build a CREATE TABLE IF NOT EXISTS statement for the destination table so
 * that replication can proceed even if the table has not yet been manually
 * created in the internal SQLite database.
 */
export function buildCreateTableQuery(
    destinationTable: string,
    columns: string[],
    trackBy?: string
): string {
    assertValidIdentifier(destinationTable, 'destinationTable')
    if (columns.length === 0) {
        throw new ReplicationConfigurationError(
            `Cannot create table ${destinationTable} without columns.`
        )
    }
    columns.forEach((column) => assertValidIdentifier(column, 'column name'))

    const colDefs = columns.map((col) => {
        if (col === trackBy) {
            return `${col} PRIMARY KEY`
        }
        return col
    })

    return `CREATE TABLE IF NOT EXISTS ${destinationTable} (${colDefs.join(', ')})`
}

/**
 * Strips or rewrites schema prefixes (e.g. `public.users` -> `users`) for queries
 * targeting replicated tables, allowing users to query SQLite with Postgres-style
 * qualified table names.
 */
export function rewriteQuerySchemaPrefixes(
    sql: string,
    tables: NormalizedReplicationTable[]
): string {
    let rewritten = sql
    for (const table of tables) {
        if (table.schema) {
            const pattern = new RegExp(
                `\\b${table.schema}\\.${table.name}\\b`,
                'gi'
            )
            rewritten = rewritten.replace(pattern, table.destinationTable)
        }
    }
    return rewritten
}
