import { createConnection, type Connection } from 'mysql2/promise'
import type {
    ColumnDef,
    PullPage,
    ReplicationAdapter,
    SqlScalar,
} from '../types'

function mysqlTypeToSqlite(t: string): ColumnDef['sqliteType'] {
    const tt = t.toLowerCase()
    if (
        tt.includes('int') ||
        tt === 'bit' ||
        tt === 'bool' ||
        tt === 'boolean'
    ) {
        return 'INTEGER'
    }
    if (
        tt.includes('decimal') ||
        tt.includes('numeric') ||
        tt.includes('float') ||
        tt.includes('double')
    ) {
        return 'REAL'
    }
    if (tt.includes('blob') || tt.includes('binary')) return 'BLOB'
    return 'TEXT'
}

export class MysqlAdapter implements ReplicationAdapter {
    private connPromise: Promise<Connection>

    constructor(connectionString: string) {
        this.connPromise = createConnection(connectionString)
    }

    private async conn() {
        return this.connPromise
    }

    async describe(table: string): Promise<ColumnDef[]> {
        const conn = await this.conn()
        const [rows] = (await conn.query(
            `SELECT COLUMN_NAME, DATA_TYPE, COLUMN_KEY
             FROM information_schema.COLUMNS
             WHERE TABLE_NAME = ?
               AND TABLE_SCHEMA = DATABASE()
             ORDER BY ORDINAL_POSITION`,
            [table]
        )) as [
            {
                COLUMN_NAME: string
                DATA_TYPE: string
                COLUMN_KEY: string
            }[],
            unknown,
        ]

        if (rows.length === 0) {
            throw new Error(
                `replication: table "${table}" not found in source database`
            )
        }

        return rows.map((r) => ({
            name: r.COLUMN_NAME,
            sqliteType: mysqlTypeToSqlite(r.DATA_TYPE),
            primaryKey: r.COLUMN_KEY === 'PRI',
        }))
    }

    async *pull(opts: {
        table: string
        watermarkColumn: string
        watermark: SqlScalar | null
        pageSize: number
    }): AsyncIterable<PullPage> {
        const conn = await this.conn()
        const tbl = `\`${opts.table.replace(/`/g, '``')}\``
        const wm = `\`${opts.watermarkColumn.replace(/`/g, '``')}\``

        let cursor = opts.watermark
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const sql =
                cursor === null
                    ? `SELECT * FROM ${tbl} ORDER BY ${wm} ASC LIMIT ${Math.floor(opts.pageSize)}`
                    : `SELECT * FROM ${tbl} WHERE ${wm} > ? ORDER BY ${wm} ASC LIMIT ${Math.floor(opts.pageSize)}`

            const [rows] = (await conn.query(
                sql,
                cursor === null ? [] : [cursor]
            )) as [Record<string, SqlScalar>[], unknown]

            if (rows.length === 0) return

            const last = rows[rows.length - 1][opts.watermarkColumn] ?? null
            yield { rows, nextWatermark: last }
            cursor = last

            if (rows.length < opts.pageSize) return
        }
    }

    async close(): Promise<void> {
        const conn = await this.conn()
        await conn.end()
    }
}
