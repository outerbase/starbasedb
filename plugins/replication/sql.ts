/**
 * SQL builders for the replication plugin. Centralised so the schema is
 * defined in one place and tests can assert against the exact statements.
 */

import type { ColumnDef } from './types'

export const WATERMARK_TABLE = '_starbase_replication_watermarks'
export const LOG_TABLE = '_starbase_replication_log'

export const CREATE_WATERMARK_TABLE = `
    CREATE TABLE IF NOT EXISTS ${WATERMARK_TABLE} (
        source TEXT NOT NULL,
        "table" TEXT NOT NULL,
        watermark_column TEXT NOT NULL,
        last_value TEXT,
        last_run_ts INTEGER,
        PRIMARY KEY (source, "table")
    )
`

export const CREATE_LOG_TABLE = `
    CREATE TABLE IF NOT EXISTS ${LOG_TABLE} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        source TEXT NOT NULL,
        "table" TEXT NOT NULL,
        rows_pulled INTEGER NOT NULL,
        ok INTEGER NOT NULL,
        error TEXT
    )
`

/**
 * Render a CREATE TABLE IF NOT EXISTS statement that mirrors the external
 * schema returned by an adapter.
 */
export function buildCreateTable(
    targetTable: string,
    columns: ColumnDef[]
): string {
    if (columns.length === 0) {
        throw new Error(
            `replication: cannot create table "${targetTable}" with zero columns`
        )
    }

    const cols = columns
        .map((c) => `    "${c.name}" ${c.sqliteType}`)
        .join(',\n')

    const pks = columns.filter((c) => c.primaryKey).map((c) => `"${c.name}"`)

    const pkClause = pks.length ? `,\n    PRIMARY KEY (${pks.join(', ')})` : ''

    return `CREATE TABLE IF NOT EXISTS "${targetTable}" (\n${cols}${pkClause}\n)`
}

/**
 * Render a parameterised INSERT for a row. When `primaryKey` is supplied the
 * statement uses `INSERT OR REPLACE` so re-pulled rows update in place; when
 * omitted it falls back to `INSERT OR IGNORE` to keep append-only loads
 * idempotent against retries.
 */
export function buildInsert(
    targetTable: string,
    columns: string[],
    hasPrimaryKey: boolean
): string {
    const verb = hasPrimaryKey ? 'INSERT OR REPLACE' : 'INSERT OR IGNORE'
    const colList = columns.map((c) => `"${c}"`).join(', ')
    const placeholders = columns.map(() => '?').join(', ')
    return `${verb} INTO "${targetTable}" (${colList}) VALUES (${placeholders})`
}

export const UPSERT_WATERMARK = `
    INSERT INTO ${WATERMARK_TABLE} (source, "table", watermark_column, last_value, last_run_ts)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(source, "table") DO UPDATE SET
        watermark_column = excluded.watermark_column,
        last_value = excluded.last_value,
        last_run_ts = excluded.last_run_ts
`

export const SELECT_WATERMARK = `
    SELECT last_value FROM ${WATERMARK_TABLE} WHERE source = ? AND "table" = ?
`

export const INSERT_LOG = `
    INSERT INTO ${LOG_TABLE} (ts, source, "table", rows_pulled, ok, error)
    VALUES (?, ?, ?, ?, ?, ?)
`
