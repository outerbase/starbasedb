import { describe, it, expect, vi } from 'vitest'
import { StudioPlugin } from './index'

function basicAuth(username: string, password: string) {
    return `Basic ${btoa(`${username}:${password}`)}`
}

describe('StudioPlugin', () => {
    it('exposes metadata that allows the embedded studio route to be reached without plugin auth', () => {
        const plugin = new StudioPlugin({
            username: 'admin',
            password: 'secret',
            apiKey: 'test-api-key',
        })

        expect(plugin.name).toBe('starbasedb:studio')
        expect(plugin.opts.requiresAuth).toBe(false)
        expect(plugin.pathPrefix).toBe('/studio')
    })

    it('registers the configured route and serves the studio iframe when basic auth matches', async () => {
        const get = vi.fn()
        const app = { get } as any
        const plugin = new StudioPlugin({
            username: 'admin',
            password: 'secret',
            apiKey: 'test-api-key',
            prefix: '/admin/studio',
        })

        await plugin.register(app)

        expect(get).toHaveBeenCalledTimes(1)
        expect(get).toHaveBeenCalledWith('/admin/studio', expect.any(Function))

        const routeHandler = get.mock.calls[0][1]
        const request = new Request('https://example.com/admin/studio', {
            headers: {
                Authorization: basicAuth('admin', 'secret'),
            },
        })
        const response = await routeHandler({ req: { raw: request } })

        expect(response.status).toBe(200)
        expect(response.headers.get('Content-Type')).toBe('text/html')
        await expect(response.text()).resolves.toContain(
            'https://studio.outerbase.com/embed/starbase'
        )
    })

    it('does not register a route when the prefix is disabled', async () => {
        const get = vi.fn()
        const app = { get } as any
        const plugin = new StudioPlugin({
            username: 'admin',
            password: 'secret',
            apiKey: 'test-api-key',
            prefix: '',
        })

        await plugin.register(app)

        expect(get).not.toHaveBeenCalled()
    })
})
