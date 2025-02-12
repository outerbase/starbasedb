import { Hono } from 'hono'
import { Style } from 'hono/css'
import { jsxRenderer } from 'hono/jsx-renderer'

import { Counter } from './client/Counter'
import { getAssetImportTagsFromManifest } from './utils'

const web = new Hono()

/**
 * Layout definition for all pages to be wrapped by.
 */
web.use(
    '*',
    jsxRenderer(
        async ({ children }) => {
            const assetImportTags = await getAssetImportTagsFromManifest()

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

/**
 * Define our routes and pages below.
 */
web.get('/', (c) => {
    return c.render(
        <div id="ssr-root" data-root>
            <Counter />
        </div>
    )
})

web.get('/2', (c) => {
    return c.render(
        <div id="ssr-root" data-root>
            <p>?</p>
            <Counter />
        </div>
    )
})

export default web
