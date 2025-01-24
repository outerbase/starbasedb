import { StarbaseApp, StarbaseDBConfiguration } from '../../src/handler'
import { StarbasePlugin } from '../../src/plugin'
import { DataSource } from '../../src/types'

const SQL_QUERIES = {
    CREATE_TABLE: `
        CREATE TABLE IF NOT EXISTS tmp_query_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sql_statement TEXT NOT NULL,
            duration INTEGER NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `,
}

export class QueryLogPlugin extends StarbasePlugin {
    // Example in-memory log for demonstration purposes
    private queryLog: string[] = []

    logQuery(query: string) {
        if (!query) {
            throw new Error('Invalid query')
        }
        // Log the query (you can also implement logic to store it in a database)
        this.queryLog.push(query)
        return true // Indicate success
    }

    // Data source to run internal RPC queries
    dataSource?: DataSource
    // Execution context is the `ctx` from the worker for running delayed operations
    executionContext?: ExecutionContext
    // Add TTL configuration (default 1 day)
    private readonly ttl: number = 1

    state = {
        startTime: new Date(),
        endTime: new Date(),
        totalTime: 0,
        query: '',
    }

    constructor(opts?: { ctx?: ExecutionContext }) {
        super('starbasedb:query-log')
        this.executionContext = opts?.ctx
    }

    override async register(app: StarbaseApp) {
        app.use(async (c, next) => {
            // Create subscription table if it doesn't exist
            this.dataSource = c?.get('dataSource')
            await this.dataSource?.rpc.executeQuery({
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
        this.executionContext?.waitUntil(this.expireLog())

        return opts.result
    }

    private async addQuery(dataSource: DataSource) {
        try {
            const statement =
                'INSERT INTO tmp_query_log (sql_statement, duration) VALUES (?, ?)'
            await dataSource.rpc.executeQuery({
                sql: statement,
                params: [this.state.query, this.state.totalTime],
            })
        } catch (error) {
            console.error('Error inserting rejected allowlist query:', error)
            return []
        }
    }

    private async expireLog(): Promise<boolean> {
        try {
            if (!this.dataSource) {
                return false
            }

            const statement = `
                DELETE FROM tmp_query_log 
                WHERE created_at < datetime('now', '-' || ? || ' days')
            `
            await this.dataSource.rpc.executeQuery({
                sql: statement,
                params: [this.ttl],
            })
            return true
        } catch (error) {
            console.error('Error purging old query logs:', error)
            return false
        }
    }
}
