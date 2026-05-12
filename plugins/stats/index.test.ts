import { describe, expect, it, vi } from 'vitest'
import { StatsPlugin } from './index'
import type { StarbaseApp, StarbaseDBConfiguration } from '../../src/handler'
import type { DataSource } from '../../src/types'

type CapturedStatsRoute = {
    middleware?: (c: any, next: () => Promise<void>) => Promise<void>
    handler?: (c: any, next?: () => Promise<void>) => Promise<Response>
    path?: string
}

function createAppHarness() {
    const captured: CapturedStatsRoute = {}
    const app = {
        use: vi.fn((middleware) => {
            captured.middleware = middleware
        }),
        get: vi.fn((path, handler) => {
            captured.path = path
            captured.handler = handler
        }),
    } as unknown as StarbaseApp

    return { app, captured }
}

function createContext(opts: {
    config: StarbaseDBConfiguration
    dataSource: DataSource
}) {
    return {
        get: vi.fn((key: string) => {
            if (key === 'config') return opts.config
            if (key === 'dataSource') return opts.dataSource
            return undefined
        }),
    }
}

describe('StatsPlugin', () => {
    it('registers middleware and the internal stats route', async () => {
        const plugin = new StatsPlugin()
        const { app, captured } = createAppHarness()

        await plugin.register(app)

        expect(app.use).toHaveBeenCalledTimes(1)
        expect(app.get).toHaveBeenCalledTimes(1)
        expect(captured.path).toBe('/_internal/stats')
        expect(captured.middleware).toBeInstanceOf(Function)
        expect(captured.handler).toBeInstanceOf(Function)
    })

    it('returns internal statistics plus registered plugin names for admins', async () => {
        const plugin = new StatsPlugin()
        const { app, captured } = createAppHarness()
        const config = { role: 'admin' } as StarbaseDBConfiguration
        const dataSource = {
            rpc: {
                getStatistics: vi.fn().mockResolvedValue({
                    rowsRead: 12,
                    rowsWritten: 3,
                }),
            },
            registry: {
                currentPlugins: vi
                    .fn()
                    .mockReturnValue([
                        'starbasedb:stats',
                        'starbasedb:query-log',
                    ]),
            },
        } as unknown as DataSource
        const context = createContext({ config, dataSource })
        const next = vi.fn().mockResolvedValue(undefined)

        await plugin.register(app)
        await captured.middleware!(context, next)

        const response = await captured.handler!(context)
        const payload = (await response.json()) as any

        expect(next).toHaveBeenCalledTimes(1)
        expect(dataSource.rpc.getStatistics).toHaveBeenCalledTimes(1)
        expect(dataSource.registry?.currentPlugins).toHaveBeenCalledTimes(1)
        expect(response.status).toBe(200)
        expect(payload).toEqual({
            result: {
                rowsRead: 12,
                rowsWritten: 3,
                plugins: ['starbasedb:stats', 'starbasedb:query-log'],
            },
        })
    })

    it('rejects non-admin callers before reading statistics', async () => {
        const plugin = new StatsPlugin()
        const { app, captured } = createAppHarness()
        const config = { role: 'client' } as StarbaseDBConfiguration
        const dataSource = {
            rpc: {
                getStatistics: vi.fn(),
            },
            registry: {
                currentPlugins: vi.fn(),
            },
        } as unknown as DataSource
        const context = createContext({ config, dataSource })

        await plugin.register(app)
        await captured.middleware!(
            context,
            vi.fn().mockResolvedValue(undefined)
        )

        const response = await captured.handler!(context)

        expect(response.status).toBe(400)
        expect(await response.text()).toBe('Unauthorized request')
        expect(dataSource.rpc.getStatistics).not.toHaveBeenCalled()
        expect(dataSource.registry?.currentPlugins).not.toHaveBeenCalled()
    })
})
