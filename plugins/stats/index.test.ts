import { beforeEach, describe, expect, it, vi } from 'vitest'
import { StatsPlugin } from './index'
import type { StarbaseApp } from '../../src/handler'
import type { DataSource } from '../../src/types'

type Middleware = (context: any, next: () => Promise<void>) => Promise<void>
type Handler = (context: any, next?: () => Promise<void>) => Promise<Response>

let plugin: StatsPlugin
let middleware: Middleware
let handler: Handler
let dataSource: DataSource

const createContext = (role: string) => ({
    get: vi.fn((key: string) => {
        if (key === 'config') return { role }
        if (key === 'dataSource') return dataSource
        return undefined
    }),
})

const createApp = () =>
    ({
        use: vi.fn((registeredMiddleware: Middleware) => {
            middleware = registeredMiddleware
        }),
        get: vi.fn((path: string, registeredHandler: Handler) => {
            expect(path).toBe('/_internal/stats')
            handler = registeredHandler
        }),
    }) as unknown as StarbaseApp

describe('StatsPlugin', () => {
    beforeEach(() => {
        vi.clearAllMocks()

        dataSource = {
            rpc: {
                getStatistics: vi.fn().mockResolvedValue({
                    tables: 4,
                    rows: 120,
                }),
            },
            registry: {
                currentPlugins: vi
                    .fn()
                    .mockReturnValue(['starbasedb:stats', 'starbasedb:resend']),
            },
        } as unknown as DataSource

        plugin = new StatsPlugin()
    })

    it('initializes as an authenticated stats plugin', () => {
        expect(plugin.name).toBe('starbasedb:stats')
        expect(plugin.opts.requiresAuth).toBe(true)
        expect(plugin.prefix).toBe('/_internal/stats')
    })

    it('registers middleware and the stats route', async () => {
        const app = createApp()

        await plugin.register(app)

        expect(app.use).toHaveBeenCalledTimes(1)
        expect(app.get).toHaveBeenCalledTimes(1)
    })

    it('captures request config and data source in middleware', async () => {
        const app = createApp()
        const next = vi.fn().mockResolvedValue(undefined)

        await plugin.register(app)
        await middleware(createContext('admin'), next)

        expect(plugin.dataSource).toBe(dataSource)
        expect(next).toHaveBeenCalledTimes(1)
    })

    it('returns stats plus registered plugin names for admins', async () => {
        const app = createApp()

        await plugin.register(app)
        await middleware(
            createContext('admin'),
            vi.fn().mockResolvedValue(undefined)
        )

        const response = await handler(createContext('admin'))
        const body = await response.json()

        expect(response.status).toBe(200)
        expect(dataSource.rpc.getStatistics).toHaveBeenCalledTimes(1)
        expect(dataSource.registry?.currentPlugins).toHaveBeenCalledTimes(1)
        expect(body).toEqual({
            result: {
                tables: 4,
                rows: 120,
                plugins: ['starbasedb:stats', 'starbasedb:resend'],
            },
            error: undefined,
        })
    })

    it('rejects non-admin users before querying statistics', async () => {
        const app = createApp()

        await plugin.register(app)
        await middleware(
            createContext('user'),
            vi.fn().mockResolvedValue(undefined)
        )

        const response = await handler(createContext('user'))

        expect(response.status).toBe(400)
        expect(await response.text()).toBe('Unauthorized request')
        expect(dataSource.rpc.getStatistics).not.toHaveBeenCalled()
    })
})
