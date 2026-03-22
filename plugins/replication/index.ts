import {
    StarbaseApp,
    StarbaseDBConfiguration,
    StarbaseContext,
} from '../../src/handler'
import { StarbasePlugin } from '../../src/plugin'
import { DataSource } from '../../src/types'
import { executeExternalQuery } from '../../src/operation'
import { createResponse } from '../../src/utils'

export interface ReplicationTable {
    name: string
    cursorColumn?: string
    batchSize?: number
}

export interface ReplicationConfig {
    tables: ReplicationTable[]
}

const SQL = {
    CREATE_STATE: `
        CREATE TABLE IF NOT EXISTS tmp_replication_cursors (
            table_name TEXT PRIMARY KEY,
            last_cursor TEXT
        )
    `,
    GET_CURSOR: `SELECT last_cursor FROM tmp_replication_cursors WHERE table_name = ?`,
    SET_CURSOR: `INSERT OR REPLACE INTO tmp_replication_cursors (table_name, last_cursor) VALUES (?, ?)`,
}

export class ReplicationPlugin extends StarbasePlugin {
    private config: ReplicationConfig
    private dataSource?: DataSource
    private dbConfig?: StarbaseDBConfiguration

    constructor(config: ReplicationConfig) {
        super('starbasedb:replication', { requiresAuth: true })
        this.config = config
    }

    override async register(app: StarbaseApp) {
        app.use(async (c: StarbaseContext, next) => {
            this.dataSource = c.get('dataSource')
            this.dbConfig = c.get('config')
            await this.dataSource?.rpc.executeQuery({ sql: SQL.CREATE_STATE })
            await next()
        })

        app.post('/replication/sync', async () => {
            await this.runSync()
            return createResponse({ success: true }, undefined, 200)
        })

        app.get('/replication/status', async () => {
            if (!this.dataSource)
                return createResponse(undefined, 'Not initialized', 500)
            const rows = await this.dataSource.rpc.executeQuery({
                sql: 'SELECT * FROM tmp_replication_cursors',
            })
            return createResponse(rows, undefined, 200)
        })
    }

    public async runSync() {
        if (!this.dataSource?.external || !this.dbConfig) return
        for (const table of this.config.tables) {
            await this.syncTable(table)
        }
    }

    private async syncTable(table: ReplicationTable) {
        if (!this.dataSource || !this.dbConfig) return

        const cursorCol = table.cursorColumn ?? 'id'
        const batchSize = table.batchSize ?? 1000

        const cursorRows = (await this.dataSource.rpc.executeQuery({
            sql: SQL.GET_CURSOR,
            params: [table.name],
        })) as Record<string, any>[]

        const lastCursor = cursorRows[0]?.last_cursor ?? null

        let sql = `SELECT * FROM ${table.name}`
        const params: any[] = []

        if (lastCursor !== null) {
            sql += ` WHERE ${cursorCol} > ?`
            params.push(lastCursor)
        }

        sql += ` ORDER BY ${cursorCol} LIMIT ${batchSize}`

        const rows = (await executeExternalQuery({
            sql,
            params,
            dataSource: this.dataSource,
            config: this.dbConfig,
        })) as Record<string, any>[]

        if (!rows.length) return

        const columns = Object.keys(rows[0])
        const placeholders = columns.map(() => '?').join(', ')
        const upsertSQL = `INSERT OR REPLACE INTO ${table.name} (${columns.join(', ')}) VALUES (${placeholders})`

        for (const row of rows) {
            await this.dataSource!.rpc.executeQuery({
                sql: upsertSQL,
                params: columns.map((col) => row[col]),
            })
        }

        await this.dataSource.rpc.executeQuery({
            sql: SQL.SET_CURSOR,
            params: [table.name, String(rows[rows.length - 1][cursorCol])],
        })
    }
}
