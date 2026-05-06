import postgres from 'postgres'
import type {
    ColumnDef,
    PullPage,
    ReplicationAdapter,
    SqlScalar,
} from '../types'

/**
 * Map a Postgres type name (information_schema.columns.data_type) to a
 * SQLite affinity. Anything we don't explicitly recognise becomes TEXT,
 * which is the safe choice for SQLite (it stores all values as TEXT under
 * the TEXT affinity rule).
 */
function pgTypeToSqlite(pgType: string): ColumnDef['sqliteType'] {
    const t = pgType.toLowerCase()
    if (
        t.includes('int') ||
        t === 'bigserial' ||
        t === 'serial' ||
        t === 'smallserial'
    ) {
        return 'INTEGER'
    }
    if (
        t.includes('numeric') ||
        t.includes('decimal') ||
        t.includes('real') ||
        t.includes('double') ||
        t === 'money'
    ) {
        return 'REAL'
    }
    if (t === 'boolean') return 'INTEGER'
    if (t === 'bytea') return 'BLOB'
    return 'TEXT'
}

export class PostgresAdapter implements ReplicationAdapter {
    private client: ReturnType<typeof postgres>

    constructor(connectionString: string) {
        // Keep the pool small — replication runs on Cloudflare Workers where
        // long-lived connections are an anti-pattern. fetch_types=false skips
        // a startup query that doesn't work with PgBouncer/Hyperdrive style
        // poolers.
        this.client = postgres(connectionString, {
            max: 2,
            fetch_types: false,
        })
    }

    async describe(table: string): Promise<ColumnDef[]> {
        const parts = parseQualified(table)
        const rows = await this.client<
            { column_name: string; data_type: string }[]
        >`
            SELECT column_name, data_type
            FROM information_schema.columns
            WHERE table_schema = ${parts.schema}
              AND table_name = ${parts.name}
            ORDER BY ordinal_position
        `

        if (rows.length === 0) {
            throw new Error(
                `replication: table "${table}" not found in source (schema=${parts.schema})`
            )
        }

        const pkRows = await this.client<{ column_name: string }[]>`
            SELECT a.attname AS column_name
            FROM pg_index i
            JOIN pg_attribute a
              ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
            WHERE i.indrelid = ${`${parts.schema}.${parts.name}`}::regclass
              AND i.indisprimary
        `
        const pkSet = new Set(pkRows.map((r) => r.column_name))

        return rows.map((r) => ({
            name: r.column_name,
            sqliteType: pgTypeToSqlite(r.data_type),
            primaryKey: pkSet.has(r.column_name),
        }))
    }

    async *pull(opts: {
        table: string
        watermarkColumn: string
        watermark: SqlScalar | null
        pageSize: number
    }): AsyncIterable<PullPage> {
        const parts = parseQualified(opts.table)
        const qualified = `"${parts.schema}"."${parts.name}"`
        const wmCol = `"${opts.watermarkColumn.replace(/"/g, '""')}"`

        let cursor = opts.watermark
        // Loop pages until a short page is returned. Bounded by `pageSize`
        // and the natural end of the table; the `> cursor` predicate makes it
        // strictly progressing.
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const rows: Record<string, SqlScalar>[] =
                cursor === null
                    ? await this.client.unsafe(
                          `SELECT * FROM ${qualified} ORDER BY ${wmCol} ASC LIMIT ${opts.pageSize}`
                      )
                    : await this.client.unsafe(
                          `SELECT * FROM ${qualified} WHERE ${wmCol} > $1 ORDER BY ${wmCol} ASC LIMIT ${opts.pageSize}`,
                          [cursor as any]
                      )

            if (rows.length === 0) return

            const last = rows[rows.length - 1][opts.watermarkColumn] ?? null
            yield { rows, nextWatermark: last }
            cursor = last

            if (rows.length < opts.pageSize) return
        }
    }

    async close(): Promise<void> {
        await this.client.end({ timeout: 5 })
    }
}

function parseQualified(table: string): { schema: string; name: string } {
    const idx = table.indexOf('.')
    if (idx === -1) return { schema: 'public', name: table }
    return { schema: table.slice(0, idx), name: table.slice(idx + 1) }
}
