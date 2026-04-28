import {
    SyncAdapter,
    type ColumnDefinition,
    type FetchRowsOpts,
} from '../adapter'

export class GenericSyncAdapter extends SyncAdapter {
    buildIntrospectQuery(table: string, _schema: string) {
        return {
            sql: `PRAGMA table_info(?)`,
            params: [table] as unknown[],
        }
    }

    parseIntrospectResult(rows: Record<string, unknown>[]): ColumnDefinition[] {
        return rows.map((r) => ({
            name: String(r.name),
            sourceType: String(r.type),
            sqliteType: this.mapType(String(r.type)),
            nullable: r.notnull === 0 || r.notnull === '0',
        }))
    }

    buildFetchQuery(opts: FetchRowsOpts) {
        const { table, cursorColumn, cursorValue, columns, limit } = opts
        const cols = columns?.map((c) => `"${c}"`).join(', ') ?? '*'

        if (cursorValue === null) {
            return {
                sql: `SELECT ${cols} FROM "${table}" ORDER BY "${cursorColumn}" ASC LIMIT ?`,
                params: [limit] as unknown[],
            }
        }

        return {
            sql: `SELECT ${cols} FROM "${table}" WHERE "${cursorColumn}" > ? ORDER BY "${cursorColumn}" ASC LIMIT ?`,
            params: [cursorValue, limit] as unknown[],
        }
    }

    private mapType(sqliteType: string): 'TEXT' | 'INTEGER' | 'REAL' | 'BLOB' {
        const t = sqliteType.toUpperCase()
        if (t.includes('INT')) return 'INTEGER'
        if (
            ['REAL', 'FLOAT', 'DOUBLE', 'NUMERIC', 'DECIMAL'].some((k) =>
                t.includes(k)
            )
        )
            return 'REAL'
        if (t.includes('BLOB')) return 'BLOB'
        return 'TEXT'
    }
}
