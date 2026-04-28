import type { ConflictStrategy } from './types'

export interface ColumnDefinition {
    name: string
    sourceType: string
    sqliteType: 'TEXT' | 'INTEGER' | 'REAL' | 'BLOB'
    nullable: boolean
}

export interface FetchRowsOpts {
    table: string
    schema: string
    cursorColumn: string
    cursorValue: string | null
    columns?: string[]
    limit: number
}

export abstract class SyncAdapter {
    abstract buildIntrospectQuery(
        table: string,
        schema: string
    ): { sql: string; params: unknown[] }

    abstract parseIntrospectResult(
        rows: Record<string, unknown>[]
    ): ColumnDefinition[]

    abstract buildFetchQuery(opts: FetchRowsOpts): {
        sql: string
        params: unknown[]
    }

    buildCreateTableSQL(
        targetTable: string,
        columns: ColumnDefinition[],
        primaryKey?: string
    ): string {
        const cols = columns
            .map(
                (c) =>
                    `"${c.name}" ${c.sqliteType}${c.nullable ? '' : ' NOT NULL'}`
            )
            .join(', ')
        const pkClause = primaryKey ? `, PRIMARY KEY ("${primaryKey}")` : ''
        return `CREATE TABLE IF NOT EXISTS "${targetTable}" (${cols}${pkClause})`
    }

    buildUpsertSQL(
        targetTable: string,
        columns: string[],
        strategy: ConflictStrategy
    ): string {
        const or = strategy === 'replace' ? 'OR REPLACE' : 'OR IGNORE'
        const colList = columns.map((c) => `"${c}"`).join(', ')
        const placeholders = columns.map(() => '?').join(', ')
        return `INSERT ${or} INTO "${targetTable}" (${colList}) VALUES (${placeholders})`
    }
}
