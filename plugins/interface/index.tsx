import { DataSource } from '../../dist'
import { StarbaseApp } from '../../src/handler'
import { StarbasePlugin } from '../../src/plugin'
import { Handler } from 'hono'

import { getAssetImportTagsFromManifest } from './utils/index'
import { jsxRenderer } from 'hono/jsx-renderer'
import { Style } from 'hono/css'

interface RouteMapping {
    path: string
    page: string
}

export class InterfacePlugin extends StarbasePlugin {
    // Prefix route
    pathPrefix: string = '/unused-but-required'
    // Data source to run internal RPC queries
    dataSource?: DataSource
    // Array of routes registered in this class
    private _supportedRoutes: RouteMapping[] = []

    constructor() {
        super('starbasedb:interface', {
            requiresAuth: false,
        })
    }

    private registerRoute(
        app: StarbaseApp,
        routeMapping: RouteMapping,
        handler: Handler
    ) {
        this._supportedRoutes.push(routeMapping)
        app.get(routeMapping.path, handler)
    }

    override async register(app: StarbaseApp) {
        app.use(async (c, next) => {
            this.dataSource = c?.get('dataSource')
            await next()
        })

        app.use(
            '*',
            jsxRenderer(
                async ({ children }, c) => {
                    // Get current URL path
                    const path = new URL(c.req.url).pathname

                    // Find matching route and get its page name
                    const currentRoute = this._supportedRoutes.find((route) => {
                        const routeParts = route.path.split('/')
                        const pathParts = path.split('/')

                        if (routeParts.length !== pathParts.length) return false

                        return routeParts.every((part, i) => {
                            if (part.startsWith(':')) return true // Match any value for parameters
                            return part === pathParts[i]
                        })
                    })

                    const assetImportTags =
                        await getAssetImportTagsFromManifest(currentRoute?.page)

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

                                <script
                                    dangerouslySetInnerHTML={{
                                        __html: `
                                        // Check theme on page load
                                        const theme = document.cookie
                                            .split('; ')
                                            .find(row => row.startsWith('theme='))
                                            ?.split('=')[1];
                                        if (theme === 'dark') {
                                            document.documentElement.classList.add('dark');
                                        }
                                    `,
                                    }}
                                />
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

        this.registerRoute(
            app,
            { path: '/template', page: 'template' },
            (c) => {
                return c.render(<div id="root" data-client="template"></div>)
            }
        )

        this.registerRoute(app, { path: '/', page: 'page1' }, (c) => {
            // `data-client` value must match the name of the folder the page component is contained within.
            return c.render(<div id="root" data-client="page1"></div>)
        })

        this.registerRoute(app, { path: '/1', page: 'page1' }, (c) => {
            // Multiple routes can reference the same component
            return c.render(<div id="root" data-client="page1"></div>)
        })

        this.registerRoute(app, { path: '/2', page: 'page2' }, async (c) => {
            // We can query the database before responding with any server data to render a page
            const result = (await this.dataSource?.rpc.executeQuery({
                sql: `SELECT COUNT(*) as count FROM user LIMIT ?`,
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

        this.registerRoute(app, { path: '/home', page: 'home' }, (c) => {
            return c.render(<div id="root" data-client="home"></div>)
        })

        this.registerRoute(app, { path: '/chat/:id', page: 'chat' }, (c) => {
            const { id } = c.req.param()
            return c.render(
                <div
                    id="root"
                    data-client="chat"
                    data-server-props={JSON.stringify({ id })}
                ></div>
            )
        })
    }

    public get supportedRoutes(): string[] {
        return this._supportedRoutes.map((route) => route.path)
    }

    /**
     * Checks if a given pathname matches any of the supported routes
     * @param pathname The URL pathname to check
     * @returns boolean indicating if the pathname matches a supported route
     */
    public matchesRoute(pathname: string): boolean {
        return this.supportedRoutes.some((route) =>
            this.matchRoute(route, pathname)
        )
    }

    private matchRoute(supportedRoute: string, pathname: string): boolean {
        const supportedParts = supportedRoute.split('/')
        const pathParts = pathname.split('/')

        if (supportedParts.length !== pathParts.length) return false

        return supportedParts.every((part, i) => {
            if (part.startsWith(':')) return true // Match any value for parameters
            return part === pathParts[i]
        })
    }
}
