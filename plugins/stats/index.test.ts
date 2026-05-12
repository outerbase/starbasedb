import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { StatsPlugin } from './index'

const createMockDataSource = (
    stats: Record<string, unknown> = { tables: 3, rows: 42 }
) => ({
    rpc: {
        getStatistics: vi.fn().mockResolvedValue(stats),
    },
    registry: {
        currentPlugins: vi
            .fn()
            .mockReturnValue(['starbasedb:stats', 'starbasedb:query-log']),
    },
})

async function createApp(opts: { role?: string; dataSource?: any }) {
    const app = new Hono()
    const plugin = new StatsPlugin()

    app.use(async (c, next) => {
        const context = c as any
        context.set('config', { role: opts.role })
        context.set('dataSource', opts.dataSource)
        await next()
    })
    await plugin.register(app as any)

    return { app, plugin }
}

describe('StatsPlugin', () => {
    it('initializes with stats metadata and auth required', () => {
        const plugin = new StatsPlugin()

        expect(plugin.name).toBe('starbasedb:stats')
        expect(plugin.prefix).toBe('/_internal/stats')
        expect(plugin.opts.requiresAuth).toBe(true)
    })

    it('rejects non-admin requests', async () => {
        const dataSource = createMockDataSource()
        const { app } = await createApp({ role: 'user', dataSource })

        const response = await app.request('/_internal/stats')

        expect(response.status).toBe(400)
        await expect(response.text()).resolves.toBe('Unauthorized request')
        expect(dataSource.rpc.getStatistics).not.toHaveBeenCalled()
        expect(dataSource.registry.currentPlugins).not.toHaveBeenCalled()
    })

    it('returns internal statistics and current plugin names for admins', async () => {
        const dataSource = createMockDataSource({
            tables: 4,
            rows: 128,
            sizeBytes: 4096,
        })
        const { app } = await createApp({ role: 'admin', dataSource })

        const response = await app.request('/_internal/stats')

        expect(response.status).toBe(200)
        await expect(response.json()).resolves.toEqual({
            result: {
                tables: 4,
                rows: 128,
                sizeBytes: 4096,
                plugins: ['starbasedb:stats', 'starbasedb:query-log'],
            },
        })
        expect(dataSource.rpc.getStatistics).toHaveBeenCalledOnce()
        expect(dataSource.registry.currentPlugins).toHaveBeenCalledOnce()
    })

    it('returns an empty stats object when no data source is available', async () => {
        const { app } = await createApp({ role: 'admin' })

        const response = await app.request('/_internal/stats')

        expect(response.status).toBe(200)
        await expect(response.json()).resolves.toEqual({
            result: {},
        })
    })

    it('refreshes request config and data source through middleware', async () => {
        const plugin = new StatsPlugin()
        const app = new Hono()
        const userDataSource = createMockDataSource({ rows: 1 })
        const adminDataSource = createMockDataSource({ rows: 2 })
        let requestRole = 'user'
        let requestDataSource = userDataSource

        app.use(async (c, next) => {
            const context = c as any
            context.set('config', { role: requestRole })
            context.set('dataSource', requestDataSource)
            await next()
        })
        await plugin.register(app as any)

        const rejected = await app.request('/_internal/stats')
        expect(rejected.status).toBe(400)
        expect(userDataSource.rpc.getStatistics).not.toHaveBeenCalled()

        requestRole = 'admin'
        requestDataSource = adminDataSource

        const accepted = await app.request('/_internal/stats')

        expect(accepted.status).toBe(200)
        await expect(accepted.json()).resolves.toEqual({
            result: {
                rows: 2,
                plugins: ['starbasedb:stats', 'starbasedb:query-log'],
            },
        })
        expect(adminDataSource.rpc.getStatistics).toHaveBeenCalledOnce()
    })
})
