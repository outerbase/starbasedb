import { DataSource } from '../../dist'
import { StarbaseApp } from '../../src/handler'
import { StarbasePlugin } from '../../src/plugin'

import { getAssetImportTagsFromManifest } from './utils'
import { jsxRenderer } from 'hono/jsx-renderer'
import { Style } from 'hono/css'

export class InterfacePlugin extends StarbasePlugin {
    // Prefix route
    pathPrefix: string = '/unused-but-required'
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

    public supportedRoutes: string[] = ['/', '/2']

    override async register(app: StarbaseApp) {
        app.use(async (c, next) => {
            this.dataSource = c?.get('dataSource')
            await next()
        })

        app.use(
            '*',
            jsxRenderer(
                async ({ children }) => {
                    const assetImportTags =
                        await getAssetImportTagsFromManifest()

                    return (
                        <html lang="en">
                            <head>
                                <meta charSet="utf-8" />
                                <meta
                                    content="width=device-width, initial-scale=1"
                                    name="viewport"
                                />

                                <title>Starbase + Hono</title>
                                <link rel="icon" href="/favicon.svg" />

                                <Style />
                                {assetImportTags}
                            </head>

                            <body>{children}</body>
                        </html>
                    )
                },
                { docType: true }
            )
        )

        app.get(`/`, (c) => {
            // `data-client` value must match the name of the folder the page component is contained within.
            return c.render(<div id="root" data-client="page1"></div>)
        })

        app.get(`/1`, (c) => {
            // Multiple routes can reference the same component
            return c.render(<div id="root" data-client="page1"></div>)
        })

        app.get(`/2`, async (c) => {
            // We can query the database before responding with any server data to render a page
            const result = (await this.dataSource?.rpc.executeQuery({
                sql: `SELECT COUNT(*) as count FROM users LIMIT ?`,
                params: [25],
            })) as Record<string, any>[]

            const serverData = {
                initialCount: result[0].count,
                message: `You have ${result[0].count} users registered`,
            }

            // We can pass data from the server to our components by utilizing `data-server-props`
            return c.render(
                <div
                    id="root"
                    data-client="page2"
                    data-server-props={JSON.stringify(serverData)}
                ></div>
            )
        })
    }
}
