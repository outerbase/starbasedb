import {
    SyncAdapter,
    type ColumnDefinition,
    type FetchRowsOpts,
} from '../adapter'

export class PostgresSyncAdapter extends SyncAdapter {
    buildIntrospectQuery(table: string, schema: string) {
        return {
            sql: `SELECT column_name, data_type, is_nullable
                  FROM information_schema.columns
                  WHERE table_schema = ? AND table_name = ?
                  ORDER BY ordinal_position`,
            params: [schema, table] as unknown[],
        }
    }

    parseIntrospectResult(rows: Record<string, unknown>[]): ColumnDefinition[] {
        return rows.map((r) => ({
            name: String(r.column_name),
            sourceType: String(r.data_type),
            sqliteType: this.mapType(String(r.data_type)),
            nullable: r.is_nullable === 'YES',
        }))
    }

    buildFetchQuery(opts: FetchRowsOpts) {
        const { table, schema, cursorColumn, cursorValue, columns, limit } =
            opts
        const cols = columns?.map((c) => `"${c}"`).join(', ') ?? '*'
        const tbl = schema ? `"${schema}"."${table}"` : `"${table}"`

        if (cursorValue === null) {
            return {
                sql: `SELECT ${cols} FROM ${tbl} ORDER BY "${cursorColumn}" ASC LIMIT ?`,
                params: [limit] as unknown[],
            }
        }

        return {
            sql: `SELECT ${cols} FROM ${tbl} WHERE "${cursorColumn}" > ? ORDER BY "${cursorColumn}" ASC LIMIT ?`,
            params: [cursorValue, limit] as unknown[],
        }
    }

    private mapType(pgType: string): 'TEXT' | 'INTEGER' | 'REAL' | 'BLOB' {
        if (
            [
                'integer',
                'bigint',
                'smallint',
                'serial',
                'bigserial',
                'boolean',
            ].includes(pgType)
        ) {
            return 'INTEGER'
        }

        if (
            ['real', 'double precision', 'numeric', 'decimal', 'float'].some(
                (t) => pgType.startsWith(t)
            )
        ) {
            return 'REAL'
        }

        if (pgType === 'bytea') return 'BLOB'

        // json and jsonb must explicitly return TEXT — SQLite has no native JSON
        // storage type. Some ORMs infer BLOB for jsonb; TEXT is correct here.
        // SQLite's json() functions work on TEXT values.
        if (['json', 'jsonb'].includes(pgType)) return 'TEXT'

        return 'TEXT'
    }
}
