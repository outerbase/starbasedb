import {
    SyncAdapter,
    type ColumnDefinition,
    type FetchRowsOpts,
} from '../adapter'

export class GenericSyncAdapter extends SyncAdapter {
    buildIntrospectQuery(table: string, _schema: string) {
        return {
            sql: `PRAGMA table_info("${table}")`,
            params: [] as unknown[],
        }
    }

    parseIntrospectResult(rows: Record<string, unknown>[]): ColumnDefinition[] {
        return rows.map((r) => ({
            name: String(r.name),
            sourceType: String(r.type || 'TEXT'),
            sqliteType: this.mapType(String(r.type || 'TEXT').toLowerCase()),
            nullable: Number(r.notnull) === 0,
        }))
    }

    buildFetchQuery(opts: FetchRowsOpts) {
        const { table, cursorColumn, cursorValue, columns, limit } = opts
        const cols = columns?.map((c) => `"${c}"`).join(', ') ?? '*'

        if (cursorValue === null || cursorValue === undefined) {
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

    private mapType(typeStr: string): 'TEXT' | 'INTEGER' | 'REAL' | 'BLOB' {
        const t = typeStr.toLowerCase()

        if (
            [
                'int',
                'integer',
                'tinyint',
                'smallint',
                'mediumint',
                'bigint',
            ].some((k) => t.includes(k))
        ) {
            return 'INTEGER'
        }

        if (['real', 'floa', 'doub'].some((k) => t.includes(k))) {
            return 'REAL'
        }

        if (t.includes('blob')) {
            return 'BLOB'
        }

        return 'TEXT'
    }
}
