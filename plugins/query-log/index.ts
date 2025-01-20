import {
    StarbaseApp,
    StarbaseContext,
    StarbaseDBConfiguration,
} from '../../src/handler'
import { StarbasePlugin } from '../../src/plugin'
import { DataSource } from '../../src/types'

const SQL_QUERIES = {
    CREATE_TABLE: `
        CREATE TABLE IF NOT EXISTS tmp_query_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sql_statement TEXT NOT NULL,
            duration INTEGER NOT NULL,
            status INTEGER NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `,
}

export class QueryLogPlugin extends StarbasePlugin {
    config?: StarbaseDBConfiguration
    context?: StarbaseContext

    state = {
        startTime: new Date(),
        endTime: new Date(),
        totalTime: 0,
        query: '',
        status: 200,
    }

    constructor() {
        super('starbasedb:query-log')
    }

    override async register(app: StarbaseApp) {
        app.use(async (c, next) => {
            this.config = c?.get('config')
            this.context = c

            console.log('Registered my QueryLogPlugin')
            // Create subscription table if it doesn't exist
            const dataSource = c?.get('dataSource')
            await dataSource?.rpc.executeQuery({
                sql: SQL_QUERIES.CREATE_TABLE,
                params: [],
            })

            await next()
        })
    }

    override async beforeQuery(opts: {
        sql: string
        params?: unknown[]
        dataSource?: DataSource
        config?: StarbaseDBConfiguration
    }): Promise<{ sql: string; params?: unknown[] }> {
        let { sql, params } = opts

        this.state.query = sql
        this.state.startTime = new Date()

        return Promise.resolve({
            sql,
            params,
        })
    }

    override async afterQuery(opts: {
        sql: string
        result: any
        isRaw: boolean
        dataSource?: DataSource
        config?: StarbaseDBConfiguration
    }): Promise<any> {
        this.state.endTime = new Date()
        this.state.totalTime =
            this.state.endTime.getTime() - this.state.startTime.getTime()

        if (opts.dataSource) {
            this.addQuery(opts?.dataSource)
        }

        // Do a purge action for older than TTL items
        // this.context.waitUntil(this.expireLog())
        // Maybe a global callable method to trigger ctx.waitUntil and pass in an arbitrary function to execute?

        return opts.result
    }

    private async addQuery(dataSource: DataSource) {
        try {
            const statement =
                'INSERT INTO tmp_query_log (sql_statement, duration, status) VALUES (?, ?, ?)'
            await dataSource.rpc.executeQuery({
                sql: statement,
                params: [
                    this.state.query,
                    this.state.totalTime,
                    this.state.status,
                ],
            })
        } catch (error) {
            console.error('Error inserting rejected allowlist query:', error)
            return []
        }
    }

    private expireLog() {}
}
