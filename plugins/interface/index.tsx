import { Hono } from 'hono'
import { DataSource } from '../../dist'
import { StarbaseApp } from '../../src/handler'
import { StarbasePlugin } from '../../src/plugin'
// import web from './web'

import { getAssetImportTagsFromManifest } from './utils'
import { jsxRenderer } from 'hono/jsx-renderer'
import { Style } from 'hono/css'

const web = new Hono()

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

        app.get('/', (c) => {
            return c.render(<div id="root" data-client="page1"></div>)
        })

        app.get('/1', (c) => {
            return c.render(<div id="root" data-client="page1"></div>)
        })

        app.get('/2', async (c) => {
            // Example server-side logic
            const serverData = {
                initialCount: 42,
                message: 'Hello from server!',
            }

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
