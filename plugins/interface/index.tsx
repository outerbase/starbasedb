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
                                <title>StarbaseDB</title>
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

        // An example route and page definition to show you how to add new pages.
        // page - declares how a user will access this page
        // page - maps to a folder name in `./pages/${name}/index.tsx
        // data-client - maps to the same name as the page above
        this.registerRoute(
            app,
            { path: '/template', page: 'template' },
            (c) => {
                return c.render(<div id="root" data-client="template"></div>)
            }
        )
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
