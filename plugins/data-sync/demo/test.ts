import { DataSyncPlugin } from '../index'
import { Hono, Context } from 'hono'
import { StarbaseDBDurableObject } from '../../../src/do'

export { StarbaseDBDurableObject }

const app = new Hono()

class DataSyncDemoPlugin {
    private dataSyncPlugin: DataSyncPlugin
    private name: string
    private isRegistered: boolean = false
    private lastQuery: string = ''
    private lastResult: any = null
    private syncInterval: number = 30
    private tables: string[] = ['users', 'posts']

    constructor() {
        this.name = 'starbasedb:data-sync-demo'
        this.dataSyncPlugin = new DataSyncPlugin({
            sync_interval: this.syncInterval,
            tables: this.tables,
        })
    }

    async register(app: any) {
        if (this.isRegistered) {
            return
        }

        // Register the data sync plugin
        await this.dataSyncPlugin.register(app)

        // Basic status endpoint
        app.get('/sync-status', (c: Context) => {
            return new Response(
                JSON.stringify({
                    status: 'running',
                    tables: ['users', 'posts'],
                    last_sync: new Date().toISOString(),
                }),
                {
                    headers: { 'Content-Type': 'application/json' },
                }
            )
        })

        // Mock data endpoint
        app.get('/sync-data', async (c: Context) => {
            const mockData = {
                users: [
                    { id: 1, name: 'Alice Smith', email: 'alice@example.com' },
                    { id: 2, name: 'Bob Jones', email: 'bob@example.com' },
                    {
                        id: 3,
                        name: 'Charlie Brown',
                        email: 'charlie@example.com',
                    },
                ],
                posts: [
                    {
                        id: 1,
                        user_id: 1,
                        title: 'First Post',
                        content: 'Hello World!',
                    },
                    {
                        id: 2,
                        user_id: 2,
                        title: 'Testing',
                        content: 'This is a test post',
                    },
                    {
                        id: 3,
                        user_id: 3,
                        title: 'Another Post',
                        content: 'More test content',
                    },
                ],
            }

            return new Response(JSON.stringify(mockData), {
                headers: { 'Content-Type': 'application/json' },
            })
        })

        // Test query hooks
        app.post('/test-query', async (c: Context) => {
            const body = await c.req.json()
            const { sql, params } = body

            try {
                // This will trigger beforeQuery and afterQuery hooks
                const result = await this.beforeQuery({ sql, params })
                const queryResult = {
                    success: true,
                    message: 'Query intercepted',
                }
                const afterResult = await this.afterQuery({
                    sql,
                    result: queryResult,
                    isRaw: false,
                })

                return new Response(
                    JSON.stringify({
                        success: true,
                        result: afterResult,
                        lastQuery: this.lastQuery,
                        lastResult: this.lastResult,
                    }),
                    {
                        headers: { 'Content-Type': 'application/json' },
                    }
                )
            } catch (err) {
                const error = err as Error
                return new Response(
                    JSON.stringify({
                        success: false,
                        error: error.message,
                    }),
                    {
                        status: 500,
                        headers: { 'Content-Type': 'application/json' },
                    }
                )
            }
        })

        // Force sync endpoint
        app.post('/force-sync', async (c: Context) => {
            try {
                // Simulate sync by running a test query
                await this.beforeQuery({ sql: 'SELECT * FROM users' })

                return new Response(
                    JSON.stringify({
                        success: true,
                        message: 'Sync simulation triggered successfully',
                    }),
                    {
                        headers: { 'Content-Type': 'application/json' },
                    }
                )
            } catch (err) {
                const error = err as Error
                return new Response(
                    JSON.stringify({
                        success: false,
                        error: error.message,
                    }),
                    {
                        status: 500,
                        headers: { 'Content-Type': 'application/json' },
                    }
                )
            }
        })

        // Debug endpoint
        app.get('/debug', (c: Context) => {
            return new Response(
                JSON.stringify({
                    plugin_name: this.name,
                    is_registered: this.isRegistered,
                    last_query: this.lastQuery,
                    last_result: this.lastResult,
                    data_sync_config: {
                        sync_interval: this.syncInterval,
                        tables: this.tables,
                    },
                }),
                {
                    headers: { 'Content-Type': 'application/json' },
                }
            )
        })

        this.isRegistered = true
    }

    async beforeQuery(opts: { sql: string; params?: unknown[] }) {
        console.log('Demo plugin intercepting query:', opts.sql)
        this.lastQuery = opts.sql
        return opts
    }

    async afterQuery(opts: { sql: string; result: any; isRaw: boolean }) {
        console.log('Demo plugin received result for query:', opts.sql)
        this.lastResult = opts.result
        return opts.result
    }
}

// Initialize the plugin
const plugin = new DataSyncDemoPlugin()

// Create and export the fetch handler
export default {
    async fetch(request: Request, env: any, ctx: any) {
        // Register the plugin if not already registered
        await plugin.register(app)

        // Handle the request
        return app.fetch(request, env, ctx)
    },
}
