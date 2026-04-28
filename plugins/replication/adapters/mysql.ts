import {
    SyncAdapter,
    type ColumnDefinition,
    type FetchRowsOpts,
} from '../adapter'

export class MySQLSyncAdapter extends SyncAdapter {
    buildIntrospectQuery(table: string, schema: string) {
        return {
            sql: `SELECT COLUMN_NAME AS column_name, DATA_TYPE AS data_type, IS_NULLABLE AS is_nullable
                  FROM INFORMATION_SCHEMA.COLUMNS
                  WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
                  ORDER BY ORDINAL_POSITION`,
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
        const cols = columns?.map((c) => `\`${c}\``).join(', ') ?? '*'
        const tbl = schema ? `\`${schema}\`.\`${table}\`` : `\`${table}\``

        if (cursorValue === null) {
            return {
                sql: `SELECT ${cols} FROM ${tbl} ORDER BY \`${cursorColumn}\` ASC LIMIT ?`,
                params: [limit] as unknown[],
            }
        }

        return {
            sql: `SELECT ${cols} FROM ${tbl} WHERE \`${cursorColumn}\` > ? ORDER BY \`${cursorColumn}\` ASC LIMIT ?`,
            params: [cursorValue, limit] as unknown[],
        }
    }

    private mapType(mysqlType: string): 'TEXT' | 'INTEGER' | 'REAL' | 'BLOB' {
        const t = mysqlType.toLowerCase()

        if (
            [
                'int',
                'integer',
                'tinyint',
                'smallint',
                'mediumint',
                'bigint',
            ].some((k) => t === k || t.startsWith(k + '('))
        ) {
            return 'INTEGER'
        }

        if (
            ['float', 'double', 'decimal', 'numeric', 'real'].some(
                (k) => t === k || t.startsWith(k + '(')
            )
        ) {
            return 'REAL'
        }

        if (
            [
                'blob',
                'tinyblob',
                'mediumblob',
                'longblob',
                'binary',
                'varbinary',
            ].some((k) => t === k || t.startsWith(k))
        ) {
            return 'BLOB'
        }

        return 'TEXT'
    }
}
