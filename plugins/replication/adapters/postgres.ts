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
            sqliteType: this.mapType(String(r.data_type).toLowerCase()),
            nullable: String(r.is_nullable).toUpperCase() === 'YES',
        }))
    }

    buildFetchQuery(opts: FetchRowsOpts) {
        const { table, schema, cursorColumn, cursorValue, columns, limit } =
            opts
        const cols = columns?.map((c) => `"${c}"`).join(', ') ?? '*'
        const tbl = schema ? `"${schema}"."${table}"` : `"${table}"`

        if (cursorValue === null || cursorValue === undefined) {
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
                'int',
                'int2',
                'int4',
                'int8',
            ].includes(pgType)
        ) {
            return 'INTEGER'
        }

        if (
            [
                'real',
                'double precision',
                'numeric',
                'decimal',
                'float',
                'float4',
                'float8',
            ].some((t) => pgType.startsWith(t))
        ) {
            return 'REAL'
        }

        if (pgType === 'bytea') {
            return 'BLOB'
        }

        // json and jsonb must map to TEXT in SQLite so built-in json functions work seamlessly
        if (['json', 'jsonb'].includes(pgType)) {
            return 'TEXT'
        }

        return 'TEXT'
    }
}
