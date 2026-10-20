import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CronPlugin } from './index'
import { parseCronExpression, getNextExecutionTime } from './utils'
import type { DataSource } from '../../src/types'

describe('Cron Utilities', () => {
    it('should parse valid cron expression', () => {
        const expr = parseCronExpression('*/5 * * * *')
        expect(expr).toBeDefined()
    })

    it('should calculate next execution time in the future', () => {
        const now = 1700000000000
        const nextTime = getNextExecutionTime('*/10 * * * *', now)
        expect(nextTime).toBeGreaterThan(now)
    })
})

describe('CronPlugin', () => {
    let plugin: CronPlugin
    let mockRpc: any
    let mockDataSource: DataSource

    beforeEach(() => {
        vi.restoreAllMocks()

        mockRpc = {
            executeQuery: vi.fn(),
            setAlarm: vi.fn(),
            deleteAlarm: vi.fn(),
        }

        mockDataSource = {
            source: 'internal',
            internal: {} as any,
            rpc: mockRpc,
        }

        plugin = new CronPlugin()
    })

    it('should initialize with correct plugin name and auth requirement', () => {
        expect(plugin.name).toBe('starbasedb:cron')
        expect(plugin.opts.requiresAuth).toBe(true)
        expect(plugin.pathPrefix).toBe('/cron')
    })

    it('should throw an error on addEvent if plugin is not initialized with dataSource', async () => {
        await expect(
            plugin.addEvent(
                '*/5 * * * *',
                'sample_task',
                {},
                'http://localhost'
            )
        ).rejects.toThrow('CronPlugin not properly initialized')
    })

    it('should register middleware and callback route on app', async () => {
        const mockApp: any = {
            use: vi.fn(),
            post: vi.fn(),
        }

        await plugin.register(mockApp)

        expect(mockApp.use).toHaveBeenCalledTimes(1)
        expect(mockApp.post).toHaveBeenCalledWith(
            '/cron/callback',
            expect.any(Function)
        )
    })

    it('should invoke event callbacks when callback endpoint receives payloads', async () => {
        const mockApp: any = {
            use: vi.fn(),
            post: vi.fn(),
        }

        await plugin.register(mockApp)

        const callbackHandler = mockApp.post.mock.calls.find(
            (call: any[]) => call[0] === '/cron/callback'
        )[1]

        const eventCallback = vi.fn()
        plugin.onEvent(eventCallback)

        const mockContext: any = {
            req: {
                json: vi.fn().mockResolvedValue([
                    {
                        name: 'daily_sync',
                        cron_tab: '0 0 * * *',
                        payload: { action: 'sync' },
                    },
                ]),
            },
        }

        const res = await callbackHandler(mockContext)
        expect(res.status).toBe(200)
        expect(eventCallback).toHaveBeenCalledWith({
            name: 'daily_sync',
            cron_tab: '0 0 * * *',
            payload: { action: 'sync' },
        })
    })

    it('should handle ctx.waitUntil when onEvent callback returns a Promise', async () => {
        const mockCtx: any = {
            waitUntil: vi.fn(),
        }

        const asyncCallback = vi.fn().mockResolvedValue(true)
        plugin.onEvent(asyncCallback, mockCtx)

        const mockApp: any = {
            use: vi.fn(),
            post: vi.fn(),
        }

        await plugin.register(mockApp)
        const callbackHandler = mockApp.post.mock.calls.find(
            (call: any[]) => call[0] === '/cron/callback'
        )[1]

        const mockContext: any = {
            req: {
                json: vi.fn().mockResolvedValue([
                    {
                        name: 'backup',
                        cron_tab: '0 2 * * *',
                        payload: {},
                    },
                ]),
            },
        }

        await callbackHandler(mockContext)
        expect(mockCtx.waitUntil).toHaveBeenCalledTimes(1)
    })
})
