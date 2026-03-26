import type { FetchResult, SyncTableConfig } from './types'

/**
 * Abstract base class that every external-database adapter must extend.
 *
 * Adapters encapsulate all database-specific logic (SQL dialect differences,
 * type mapping, schema introspection) so the core DataSyncPlugin remains
 * source-agnostic.  To add support for a new database, create a subclass that
 * implements `fetchTableSchema` and `fetchRows`.
 *
 * Usage:
 * ```ts
 * const plugin = new DataSyncPlugin({
 *     adapter: new PostgresSyncAdapter(),
 *     config: { tables: [...] },
 * })
 * ```
 */
export abstract class SyncAdapter {
    /**
     * Human-readable identifier for the adapter (e.g. "postgresql", "mysql").
     */
    abstract readonly dialect: string

    /**
     * Fetch rows from the external source for a given table.
     *
     * @param table     Configuration for the table being synced.
     * @param queryFn   A function that sends a SQL string to the external
     *                  database and returns an array of row objects.
     * @param cursor    The last cursor value from a previous sync, or `null`
     *                  for the initial full fetch.
     * @param batchSize Maximum number of rows to return.
     */
    abstract fetchRows(
        table: SyncTableConfig,
        queryFn: (sql: string) => Promise<Record<string, unknown>[]>,
        cursor: string | null,
        batchSize: number
    ): Promise<FetchResult>

    /**
     * Fetch column metadata for a given table from the external source.
     *
     * This is used during the first sync to auto-create the corresponding
     * SQLite table in the internal Durable Object store.
     *
     * @param table     Configuration for the table being synced.
     * @param queryFn   A function that sends a SQL string to the external
     *                  database and returns an array of row objects.
     */
    abstract fetchTableSchema(
        table: SyncTableConfig,
        queryFn: (sql: string) => Promise<Record<string, unknown>[]>
    ): Promise<FetchResult['columns']>

    /**
     * Map a source-native type string to the closest SQLite storage type.
     *
     * The base implementation handles the most common cases.  Override in a
     * subclass if the source database uses non-standard type names.
     */
    mapToSQLiteType(sourceType: string): string {
        const normalized = sourceType.toLowerCase()

        if (
            normalized.includes('int') ||
            normalized.includes('serial') ||
            normalized === 'boolean' ||
            normalized === 'bool'
        ) {
            return 'INTEGER'
        }

        if (
            normalized.includes('float') ||
            normalized.includes('double') ||
            normalized.includes('decimal') ||
            normalized.includes('numeric') ||
            normalized.includes('real') ||
            normalized.includes('money')
        ) {
            return 'REAL'
        }

        if (normalized.includes('blob') || normalized === 'bytea') {
            return 'BLOB'
        }

        // Everything else (varchar, text, timestamp, date, json, uuid, etc.)
        // is stored as TEXT in SQLite.
        return 'TEXT'
    }

    /**
     * Build the fully-qualified source table reference.
     * Subclasses override this when the dialect uses a different quoting style.
     */
    qualifiedSourceTable(table: SyncTableConfig): string {
        if (table.sourceSchema) {
            return `"${table.sourceSchema}"."${table.sourceTable}"`
        }
        return `"${table.sourceTable}"`
    }

    /**
     * Derive the internal SQLite table name for a given source table config.
     */
    resolveTargetTable(table: SyncTableConfig): string {
        if (table.targetTable) {
            return table.targetTable
        }
        if (table.sourceSchema) {
            return `${table.sourceSchema}_${table.sourceTable}`
        }
        return table.sourceTable
    }
}

// ---------------------------------------------------------------------------
// PostgreSQL adapter
// ---------------------------------------------------------------------------

export class PostgresSyncAdapter extends SyncAdapter {
    readonly dialect = 'postgresql'

    async fetchTableSchema(
        table: SyncTableConfig,
        queryFn: (sql: string) => Promise<Record<string, unknown>[]>
    ): Promise<FetchResult['columns']> {
        const schema = table.sourceSchema ?? 'public'
        const sql = `
            SELECT column_name, data_type
            FROM information_schema.columns
            WHERE table_schema = '${schema}'
              AND table_name   = '${table.sourceTable}'
            ORDER BY ordinal_position
        `
        const rows = await queryFn(sql)
        return rows.map((r) => ({
            name: String(r.column_name),
            sourceType: String(r.data_type),
        }))
    }

    async fetchRows(
        table: SyncTableConfig,
        queryFn: (sql: string) => Promise<Record<string, unknown>[]>,
        cursor: string | null,
        batchSize: number
    ): Promise<FetchResult> {
        const qualified = this.qualifiedSourceTable(table)
        let sql: string

        if (table.cursorColumn && cursor !== null) {
            sql = `SELECT * FROM ${qualified} WHERE "${table.cursorColumn}" > '${cursor}' ORDER BY "${table.cursorColumn}" ASC LIMIT ${batchSize}`
        } else if (table.cursorColumn) {
            sql = `SELECT * FROM ${qualified} ORDER BY "${table.cursorColumn}" ASC LIMIT ${batchSize}`
        } else {
            sql = `SELECT * FROM ${qualified} LIMIT ${batchSize}`
        }

        const rows = await queryFn(sql)
        const columns =
            rows.length > 0
                ? Object.keys(rows[0]).map((name) => ({
                      name,
                      sourceType: 'text',
                  }))
                : []

        return { columns, rows }
    }
}

// ---------------------------------------------------------------------------
// MySQL adapter
// ---------------------------------------------------------------------------

export class MySQLSyncAdapter extends SyncAdapter {
    readonly dialect = 'mysql'

    async fetchTableSchema(
        table: SyncTableConfig,
        queryFn: (sql: string) => Promise<Record<string, unknown>[]>
    ): Promise<FetchResult['columns']> {
        const schema = table.sourceSchema ?? table.sourceTable
        const sql = `
            SELECT COLUMN_NAME AS column_name, DATA_TYPE AS data_type
            FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = '${schema}'
              AND TABLE_NAME   = '${table.sourceTable}'
            ORDER BY ORDINAL_POSITION
        `
        const rows = await queryFn(sql)
        return rows.map((r) => ({
            name: String(r.column_name ?? r.COLUMN_NAME),
            sourceType: String(r.data_type ?? r.DATA_TYPE),
        }))
    }

    override qualifiedSourceTable(table: SyncTableConfig): string {
        if (table.sourceSchema) {
            return `\`${table.sourceSchema}\`.\`${table.sourceTable}\``
        }
        return `\`${table.sourceTable}\``
    }

    async fetchRows(
        table: SyncTableConfig,
        queryFn: (sql: string) => Promise<Record<string, unknown>[]>,
        cursor: string | null,
        batchSize: number
    ): Promise<FetchResult> {
        const qualified = this.qualifiedSourceTable(table)
        let sql: string

        if (table.cursorColumn && cursor !== null) {
            sql = `SELECT * FROM ${qualified} WHERE \`${table.cursorColumn}\` > '${cursor}' ORDER BY \`${table.cursorColumn}\` ASC LIMIT ${batchSize}`
        } else if (table.cursorColumn) {
            sql = `SELECT * FROM ${qualified} ORDER BY \`${table.cursorColumn}\` ASC LIMIT ${batchSize}`
        } else {
            sql = `SELECT * FROM ${qualified} LIMIT ${batchSize}`
        }

        const rows = await queryFn(sql)
        const columns =
            rows.length > 0
                ? Object.keys(rows[0]).map((name) => ({
                      name,
                      sourceType: 'text',
                  }))
                : []

        return { columns, rows }
    }
}
