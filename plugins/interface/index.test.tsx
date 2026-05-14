import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { InterfacePlugin } from './index'

describe('InterfacePlugin', () => {
    it('registers the template route and exposes supported route matching', async () => {
        const app = new Hono()
        const plugin = new InterfacePlugin()
        const dataSource = { rpc: { executeQuery: async () => [] } }

        app.use('*', async (c, next) => {
            c.set('dataSource', dataSource)
            await next()
        })

        await plugin.register(app as any)

        expect(plugin.supportedRoutes).toEqual(['/template'])
        expect(plugin.matchesRoute('/template')).toBe(true)
        expect(plugin.matchesRoute('/template/extra')).toBe(false)
        expect(plugin.matchesRoute('/other')).toBe(false)

        const response = await app.request('http://localhost/template')
        const html = await response.text()

        expect(response.status).toBe(200)
        expect(plugin.dataSource).toBe(dataSource)
        expect(html).toContain('<title>StarbaseDB</title>')
        expect(html).toContain('id="root"')
        expect(html).toContain('data-client="template"')
    })
})
