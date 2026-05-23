import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CronPlugin, type CronEventPayload } from './index'
import type { StarbaseApp } from '../../src/handler'
import type { DataSource } from '../../src/types'

type Middleware = (context: any, next: () => Promise<void>) => Promise<void>
type Handler = (context: any) => Promise<Response>

let plugin: CronPlugin
let middleware: Middleware
let callbackHandler: Handler
let dataSource: DataSource

const createApp = () =>
    ({
        use: vi.fn((registeredMiddleware: Middleware) => {
            middleware = registeredMiddleware
        }),
        post: vi.fn((path: string, registeredHandler: Handler) => {
            expect(path).toBe('/cron/callback')
            callbackHandler = registeredHandler
        }),
    }) as unknown as StarbaseApp

const createContext = (payload: CronEventPayload[] = []) => ({
    get: vi.fn((key: string) => {
        if (key === 'dataSource') return dataSource
        return undefined
    }),
    req: {
        json: vi.fn().mockResolvedValue(payload),
    },
})

describe('CronPlugin', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))

        dataSource = {
            rpc: {
                executeQuery: vi.fn().mockResolvedValue([]),
                setAlarm: vi.fn().mockResolvedValue(undefined),
            },
        } as unknown as DataSource

        plugin = new CronPlugin()
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it('initializes as an authenticated cron plugin', () => {
        expect(plugin.name).toBe('starbasedb:cron')
        expect(plugin.opts.requiresAuth).toBe(true)
        expect(plugin.pathPrefix).toBe('/cron')
    })

    it('registers middleware and callback route', async () => {
        const app = createApp()

        await plugin.register(app)

        expect(app.use).toHaveBeenCalledTimes(1)
        expect(app.post).toHaveBeenCalledTimes(1)
    })

    it('initializes the cron table and checks for scheduled tasks in middleware', async () => {
        const app = createApp()
        const next = vi.fn().mockResolvedValue(undefined)

        await plugin.register(app)
        await middleware(createContext(), next)

        expect(dataSource.rpc.executeQuery).toHaveBeenNthCalledWith(1, {
            sql: expect.stringContaining(
                'CREATE TABLE IF NOT EXISTS tmp_cron_tasks'
            ),
            params: [],
        })
        expect(dataSource.rpc.executeQuery).toHaveBeenNthCalledWith(2, {
            sql: expect.stringContaining('SELECT name, cron_tab, payload'),
            params: [],
        })
        expect(dataSource.rpc.setAlarm).not.toHaveBeenCalled()
        expect(next).toHaveBeenCalledTimes(1)
    })

    it('throws when adding an event before the plugin has a data source', async () => {
        await expect(
            plugin.addEvent('* * * * *', 'heartbeat', {}, 'https://example.com')
        ).rejects.toThrow('CronPlugin not properly initialized')
    })

    it('stores new events and schedules the next alarm', async () => {
        plugin['dataSource'] = dataSource
        vi.mocked(dataSource.rpc.executeQuery)
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([
                {
                    name: 'heartbeat',
                    cron_tab: '* * * * *',
                    payload: '{}',
                },
            ] as any)
            .mockResolvedValueOnce([])

        await plugin.addEvent(
            '* * * * *',
            'heartbeat',
            { ok: true },
            'https://example.com/cron'
        )

        expect(dataSource.rpc.executeQuery).toHaveBeenNthCalledWith(1, {
            sql: expect.stringContaining(
                'INSERT OR REPLACE INTO tmp_cron_tasks'
            ),
            params: [
                'heartbeat',
                '* * * * *',
                JSON.stringify({ ok: true }),
                'https://example.com/cron',
            ],
        })
        expect(dataSource.rpc.executeQuery).toHaveBeenNthCalledWith(2, {
            sql: expect.stringContaining('SELECT name, cron_tab, payload'),
            params: [],
        })
        expect(dataSource.rpc.executeQuery).toHaveBeenNthCalledWith(3, {
            sql: expect.stringContaining('UPDATE tmp_cron_tasks'),
            params: [
                'heartbeat',
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
            ],
        })
        expect(dataSource.rpc.setAlarm).toHaveBeenCalledWith(
            new Date('2026-01-01T00:01:00.000Z').getTime()
        )
    })

    it('dispatches callback payloads and wraps async callbacks with waitUntil', async () => {
        const app = createApp()
        const payload = [
            {
                name: 'heartbeat',
                cron_tab: '* * * * *',
                payload: { ok: true },
            },
        ]
        const callback = vi.fn().mockResolvedValue(undefined)
        const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext

        plugin.onEvent(callback, ctx)
        await plugin.register(app)

        const response = await callbackHandler(createContext(payload))
        const body = await response.json()

        expect(callback).toHaveBeenCalledWith(payload[0])
        expect(ctx.waitUntil).toHaveBeenCalledTimes(1)
        expect(response.status).toBe(200)
        expect(body).toEqual({
            result: { success: true },
            error: undefined,
        })
    })
})
