import { html } from 'hono/html'
import { DataSource } from '../../dist'
import { StarbaseApp } from '../../src/handler'
import { StarbasePlugin } from '../../src/plugin'
import IndexPage from './pages'

export class InterfacePlugin extends StarbasePlugin {
    // Prefix route
    pathPrefix: string = '/'
    // Data source to run internal RPC queries
    dataSource?: DataSource

    constructor(opts?: { prefix: string }) {
        super('starbasedb:interface', {
            requiresAuth: false,
        })

        if (opts?.prefix) {
            this.pathPrefix = opts.prefix
        }
    }

    override async register(app: StarbaseApp) {
        app.use(async (c, next) => {
            this.dataSource = c?.get('dataSource')
            await next()
        })

        app.get(`${this.pathPrefix}/`, (c) => {
            const messages = ['Good Morning', 'Good Evening', 'Good Night']
            return c.html(html`${IndexPage({ messages })}`)
        })

        app.get(`${this.pathPrefix}/2`, async (c) => {
            const result = (await this.dataSource?.rpc.executeQuery({
                sql: `SELECT * FROM users LIMIT ?`,
                params: [25],
            })) as Record<string, any>[]

            const messages = result.map((x) => x.name)
            return c.html(html`${IndexPage({ messages })}`)
        })
    }
}
