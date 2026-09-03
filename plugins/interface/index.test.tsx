import { describe, expect, it, vi } from 'vitest'
import type { StarbaseApp } from '../../src/handler'
import type { DataSource } from '../../src/types'
import { InterfacePlugin } from './index'

type MockContext = {
    get: ReturnType<typeof vi.fn>
    render?: ReturnType<typeof vi.fn>
}

type SupportedRouteState = {
    _supportedRoutes: Array<{ path: string; page: string }>
}

describe('InterfacePlugin', () => {
    it('initializes with public interface metadata and no routes', () => {
        const plugin = new InterfacePlugin()

        expect(plugin.name).toBe('starbasedb:interface')
        expect(plugin.opts).toEqual({ requiresAuth: false })
        expect(plugin.pathPrefix).toBe('/unused-but-required')
        expect(plugin.supportedRoutes).toEqual([])
        expect(plugin.matchesRoute('/template')).toBe(false)
    })

    it('registers middleware, the JSX renderer, and the template route', async () => {
        const plugin = new InterfacePlugin()
        const use = vi.fn()
        const get = vi.fn()
        const app = { use, get } as unknown as StarbaseApp

        await plugin.register(app)

        expect(use).toHaveBeenCalledTimes(2)
        expect(use.mock.calls[0]).toHaveLength(1)
        expect(use.mock.calls[0][0]).toEqual(expect.any(Function))
        expect(use.mock.calls[1][0]).toBe('*')
        expect(use.mock.calls[1][1]).toEqual(expect.any(Function))
        expect(get).toHaveBeenCalledTimes(1)
        expect(get).toHaveBeenCalledWith('/template', expect.any(Function))
        expect(plugin.supportedRoutes).toEqual(['/template'])
    })

    it('captures the request data source before continuing middleware', async () => {
        const plugin = new InterfacePlugin()
        const use = vi.fn()
        const get = vi.fn()
        const app = { use, get } as unknown as StarbaseApp

        await plugin.register(app)

        const dataSource = { rpc: {} } as unknown as DataSource
        const next = vi.fn().mockResolvedValue(undefined)
        const context: MockContext = {
            get: vi.fn((key: string) =>
                key === 'dataSource' ? dataSource : undefined
            ),
        }
        const middleware = use.mock.calls[0][0] as (
            c: MockContext,
            next: () => Promise<void>
        ) => Promise<void>

        await middleware(context, next)

        expect(context.get).toHaveBeenCalledWith('dataSource')
        expect(plugin.dataSource).toBe(dataSource)
        expect(next).toHaveBeenCalledTimes(1)
    })

    it('renders the template mount point from the registered route handler', async () => {
        const plugin = new InterfacePlugin()
        const use = vi.fn()
        const get = vi.fn()
        const app = { use, get } as unknown as StarbaseApp

        await plugin.register(app)

        const routeHandler = get.mock.calls[0][1] as (c: {
            render: (node: unknown) => unknown
        }) => unknown
        const render = vi.fn((node: unknown) => node)

        const result = routeHandler({ render })

        expect(render).toHaveBeenCalledTimes(1)
        expect(result).toBe(render.mock.results[0].value)

        const node = render.mock.calls[0][0] as {
            toString(): string | Promise<string>
        }
        const html = await Promise.resolve(node.toString())

        expect(html).toContain('id="root"')
        expect(html).toContain('data-client="template"')
    })

    it('matches exact routes and rejects extra or different segments', async () => {
        const plugin = new InterfacePlugin()
        const app = { use: vi.fn(), get: vi.fn() } as unknown as StarbaseApp

        await plugin.register(app)

        expect(plugin.matchesRoute('/template')).toBe(true)
        expect(plugin.matchesRoute('/template/extra')).toBe(false)
        expect(plugin.matchesRoute('/other')).toBe(false)
    })

    it('supports parameterized route matching through the public matcher', () => {
        const plugin = new InterfacePlugin()
        const state = plugin as unknown as SupportedRouteState

        state._supportedRoutes.push({ path: '/items/:id', page: 'item' })

        expect(plugin.matchesRoute('/items/123')).toBe(true)
        expect(plugin.matchesRoute('/items/abc')).toBe(true)
        expect(plugin.matchesRoute('/items')).toBe(false)
        expect(plugin.matchesRoute('/items/123/edit')).toBe(false)
    })
})
