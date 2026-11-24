import { describe, it, expect, vi, beforeEach } from 'vitest'
import { StatsPlugin } from './index'
import { StarbaseApp } from '../../src/handler'

type RegisteredHandler = (...args: any[]) => Promise<Response>

function createMockApp() {
    const getHandlers: Record<string, RegisteredHandler[]> = {}
    const middlewares: RegisteredHandler[] = []
    const app = {
        use: vi.fn((middleware: RegisteredHandler) => {
            middlewares.push(middleware)
        }),
        get: vi.fn((path: string, handler: RegisteredHandler) => {
            getHandlers[path] = getHandlers[path] || []
            getHandlers[path].push(handler)
        }),
    } as unknown as StarbaseApp
    return { app, getHandlers, middlewares }
}

function createMockContext(config: { role?: string } | undefined) {
    const dataSource = {
        rpc: {
            getStatistics: vi
                .fn()
                .mockResolvedValue({ totalQueries: 42, activeSessions: 3 }),
            executeQuery: vi.fn(),
        },
        registry: {
            currentPlugins: vi
                .fn()
                .mockReturnValue(['starbasedb:cron', 'starbasedb:stats']),
        },
    }
    return {
        context: {
            get: vi.fn((key: string) => {
                if (key === 'config') return config
                if (key === 'dataSource') return dataSource
                return undefined
            }),
        } as any,
        dataSource,
    }
}

async function registerPlugin(context: any) {
    const plugin = new StatsPlugin()
    const { app, getHandlers, middlewares } = createMockApp()
    await plugin.register(app)
    for (const middleware of middlewares) {
        await middleware(context, vi.fn())
    }
    return { plugin, getHandlers }
}

describe('StatsPlugin - Initialization', () => {
    it('should register under the internal stats prefix and require auth', () => {
        const plugin = new StatsPlugin()
        expect(plugin.prefix).toBe('/_internal/stats')
        expect(plugin.opts.requiresAuth).toBe(true)
    })
})

describe('StatsPlugin - register()', () => {
    it('should capture config and data source from the request context', async () => {
        const { context } = createMockContext({ role: 'admin' })
        const { getHandlers } = await registerPlugin(context)

        expect(context.get).toHaveBeenCalledWith('config')
        expect(context.get).toHaveBeenCalledWith('dataSource')
        expect(getHandlers['/_internal/stats']).toHaveLength(1)
    })
})

describe('StatsPlugin - GET /_internal/stats', () => {
    it('should return 400 for non-admin roles', async () => {
        const { context, dataSource } = createMockContext({ role: 'user' })
        const { getHandlers } = await registerPlugin(context)

        const response = await getHandlers['/_internal/stats'][0](context)

        expect(response.status).toBe(400)
        expect(await response.text()).toBe('Unauthorized request')
        expect(dataSource.rpc.getStatistics).not.toHaveBeenCalled()
    })

    it('should return 400 when no config is present', async () => {
        const { context } = createMockContext(undefined)
        const { getHandlers } = await registerPlugin(context)

        const response = await getHandlers['/_internal/stats'][0](context)

        expect(response.status).toBe(400)
    })

    it('should merge database statistics with the active plugin registry', async () => {
        const { context, dataSource } = createMockContext({ role: 'admin' })
        const { getHandlers } = await registerPlugin(context)

        const response = await getHandlers['/_internal/stats'][0](context)

        expect(response.status).toBe(200)
        expect(dataSource.rpc.getStatistics).toHaveBeenCalledTimes(1)
        expect(dataSource.registry.currentPlugins).toHaveBeenCalledTimes(1)

        const body = await response.json()
        expect(body.result).toEqual({
            totalQueries: 42,
            activeSessions: 3,
            plugins: ['starbasedb:cron', 'starbasedb:stats'],
        })
        expect(body.error).toBeUndefined()
    })
})
