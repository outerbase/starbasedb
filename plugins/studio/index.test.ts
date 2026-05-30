import { describe, expect, it, vi } from 'vitest'
import { StudioPlugin } from './index'

function basicAuth(username: string, password: string) {
    return `Basic ${btoa(`${username}:${password}`)}`
}

describe('StudioPlugin', () => {
    it('registers the default studio route and serves authenticated studio HTML', async () => {
        const get = vi.fn()
        const app = { get }
        const plugin = new StudioPlugin({
            username: 'admin',
            password: 'secret',
            apiKey: 'starbase-api-key',
        })

        await plugin.register(app as never)

        expect(get).toHaveBeenCalledTimes(1)
        expect(get).toHaveBeenCalledWith('/studio', expect.any(Function))

        const routeHandler = get.mock.calls[0][1]
        const response = await routeHandler({
            req: {
                raw: new Request('https://example.com/studio', {
                    headers: {
                        Authorization: basicAuth('admin', 'secret'),
                    },
                }),
            },
        })

        await expect(response.text()).resolves.toContain(
            'Authorization": "Bearer starbase-api-key"'
        )
        expect(response.headers.get('Content-Type')).toBe('text/html')
    })

    it('uses a custom route prefix when provided', async () => {
        const get = vi.fn()
        const plugin = new StudioPlugin({
            username: 'admin',
            password: 'secret',
            apiKey: 'key',
            prefix: '/internal/studio',
        })

        await plugin.register({ get } as never)

        expect(get).toHaveBeenCalledWith(
            '/internal/studio',
            expect.any(Function)
        )
    })

    it('does not register a route when the prefix is disabled', async () => {
        const get = vi.fn()
        const plugin = new StudioPlugin({
            apiKey: 'key',
            prefix: '',
        })

        await plugin.register({ get } as never)

        expect(get).not.toHaveBeenCalled()
    })
})
