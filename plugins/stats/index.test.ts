import { describe, it, expect, vi, beforeEach } from 'vitest'
import { StatsPlugin } from './index'
import { Hono } from 'hono'
import type { DataSource } from '../../src/types'
import type { StarbaseDBConfiguration } from '../../src/handler'

describe('StatsPlugin', () => {
    let plugin: StatsPlugin
    let mockDataSource: DataSource
    let mockConfig: StarbaseDBConfiguration

    beforeEach(() => {
        vi.clearAllMocks()

        mockConfig = {
            role: 'admin',
            outerbaseApiKey: 'test-key',
        }

        mockDataSource = {
            source: 'internal',
            rpc: {
                getStatistics: vi.fn().mockResolvedValue({
                    database_size_bytes: 40960,
                    page_count: 10,
                    page_size: 4096,
                    freelist_count: 0,
                    tables_count: 5,
                }),
            } as any,
            registry: {
                currentPlugins: vi.fn().mockReturnValue(['starbasedb:stats']),
            } as any,
        }

        plugin = new StatsPlugin()
    })

    it('should initialize with correct default name and options', () => {
        expect(plugin.name).toBe('starbasedb:stats')
        expect(plugin.opts.requiresAuth).toBe(true)
        expect(plugin.prefix).toBe('/_internal/stats')
    })

    it('should register route and return statistics for admin users', async () => {
        const app = new Hono<any>()

        app.use('*', async (c, next) => {
            c.set('config', mockConfig)
            c.set('dataSource', mockDataSource)
            await next()
        })

        await plugin.register(app as any)

        const res = await app.request('http://localhost/_internal/stats')
        expect(res.status).toBe(200)

        const body: any = await res.json()
        expect(body.result).toBeDefined()
        expect(body.result.database_size_bytes).toBe(40960)
        expect(body.result.plugins).toEqual(['starbasedb:stats'])
        expect(mockDataSource.rpc.getStatistics).toHaveBeenCalledTimes(1)
    })

    it('should reject non-admin users with 400 Unauthorized request', async () => {
        const app = new Hono<any>()

        app.use('*', async (c, next) => {
            c.set('config', { ...mockConfig, role: 'client' })
            c.set('dataSource', mockDataSource)
            await next()
        })

        await plugin.register(app as any)

        const res = await app.request('http://localhost/_internal/stats')
        expect(res.status).toBe(400)
        const text = await res.text()
        expect(text).toBe('Unauthorized request')
        expect(mockDataSource.rpc.getStatistics).not.toHaveBeenCalled()
    })

    it('should reject requests when config is undefined', async () => {
        const app = new Hono<any>()

        app.use('*', async (c, next) => {
            c.set('config', undefined)
            c.set('dataSource', mockDataSource)
            await next()
        })

        await plugin.register(app as any)

        const res = await app.request('http://localhost/_internal/stats')
        expect(res.status).toBe(400)
        expect(await res.text()).toBe('Unauthorized request')
    })
})
