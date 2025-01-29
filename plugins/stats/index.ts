import { DataSource } from '../../dist'
import { StarbaseApp, StarbaseDBConfiguration } from '../../src/handler'
import { StarbasePlugin } from '../../src/plugin'

export class StatsPlugin extends StarbasePlugin {
    // Prefix route
    prefix: string = '/_internal/stats'
    // Configuration details about the request and user
    private config?: StarbaseDBConfiguration
    // Data source to run internal RPC queries
    dataSource?: DataSource

    constructor() {
        super('starbasedb:stats', {
            requiresAuth: true,
        })
    }

    override async register(app: StarbaseApp) {
        app.use(async (c, next) => {
            this.config = c?.get('config')
            this.dataSource = c?.get('dataSource')
            await next()
        })

        app.get(this.prefix, async (c, next) => {
            // Only admin authorized users are permitted to subscribe to CDC events.
            if (this.config?.role !== 'admin') {
                return new Response('Unauthorized request', { status: 400 })
            }

            // Get stats from internal source
            const stats = await this.dataSource?.rpc.getStatistics()
            const additionalStats = {
                ...stats,
                plugins: this.dataSource?.registry?.currentPlugins(),
            }
            return new Response(JSON.stringify(additionalStats), {
                headers: {
                    'Content-Type': 'application/json',
                },
            })
        })
    }
}
