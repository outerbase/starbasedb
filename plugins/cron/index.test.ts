import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CronPlugin, type CronEventPayload } from './index'
import type { StarbaseApp } from '../../src/handler'
import type { DataSource } from '../../src/types'

type MockCronTask = {
    name: string
    cron_tab: string
    payload: string
}

type MockApp = StarbaseApp & {
    handlers: {
        use?: (c: any, next: () => Promise<void>) => Promise<void>
        post?: (c: any) => Promise<Response>
    }
}

function createMockDataSource(tasks: MockCronTask[] = []) {
    const executeQuery = vi.fn(({ sql }: { sql: string }) => {
        if (sql.includes('SELECT name, cron_tab, payload')) {
            return Promise.resolve(tasks)
        }

        return Promise.resolve([])
    })

    const setAlarm = vi.fn().mockResolvedValue(undefined)

    return {
        dataSource: {
            rpc: {
                executeQuery,
                setAlarm,
            },
        } as unknown as DataSource,
        executeQuery,
        setAlarm,
    }
}

function createMockApp(): MockApp {
    const handlers: MockApp['handlers'] = {}

    return {
        handlers,
        use: vi.fn((handler) => {
            handlers.use = handler
            return undefined
        }),
        post: vi.fn((path, handler) => {
            expect(path).toBe('/cron/callback')
            handlers.post = handler
            return undefined
        }),
    } as unknown as MockApp
}

describe('CronPlugin - registration', () => {
    let plugin: CronPlugin

    beforeEach(() => {
        vi.restoreAllMocks()
        plugin = new CronPlugin()
    })

    it('registers middleware and initializes the cron task table', async () => {
        const app = createMockApp()
        const { dataSource, executeQuery, setAlarm } = createMockDataSource()
        const next = vi.fn().mockResolvedValue(undefined)

        await plugin.register(app)
        await app.handlers.use?.({ get: vi.fn(() => dataSource) }, next)

        expect(app.use).toHaveBeenCalledTimes(1)
        expect(app.post).toHaveBeenCalledTimes(1)
        expect(executeQuery).toHaveBeenCalledWith({
            sql: expect.stringContaining(
                'CREATE TABLE IF NOT EXISTS tmp_cron_tasks'
            ),
            params: [],
        })
        expect(executeQuery).toHaveBeenCalledWith({
            sql: expect.stringContaining('SELECT name, cron_tab, payload'),
            params: [],
        })
        expect(setAlarm).not.toHaveBeenCalled()
        expect(next).toHaveBeenCalledTimes(1)
    })
})

describe('CronPlugin - scheduling', () => {
    let plugin: CronPlugin

    beforeEach(() => {
        vi.restoreAllMocks()
        plugin = new CronPlugin()
    })

    it('marks only the earliest scheduled tasks active and sets the next alarm', async () => {
        const now = Date.parse('2026-01-01T00:00:30.000Z')
        vi.spyOn(Date, 'now').mockReturnValue(now)

        const { dataSource, executeQuery, setAlarm } = createMockDataSource([
            {
                name: 'every-minute',
                cron_tab: '* * * * *',
                payload: '{}',
            },
            {
                name: 'also-every-minute',
                cron_tab: '* * * * *',
                payload: '{}',
            },
            {
                name: 'every-five-minutes',
                cron_tab: '*/5 * * * *',
                payload: '{}',
            },
        ])

        plugin['dataSource'] = dataSource

        await plugin['scheduleNextAlarm']()

        expect(executeQuery).toHaveBeenCalledWith({
            sql: expect.stringContaining('SELECT name, cron_tab, payload'),
            params: [],
        })
        expect(executeQuery).toHaveBeenCalledWith({
            sql: expect.stringContaining('UPDATE tmp_cron_tasks'),
            params: [
                'every-minute',
                'also-every-minute',
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
        expect(setAlarm).toHaveBeenCalledWith(
            Date.parse('2026-01-01T00:01:00.000Z')
        )
    })

    it('persists a new cron event and reschedules alarms', async () => {
        const { dataSource, executeQuery } = createMockDataSource()
        plugin['dataSource'] = dataSource

        await plugin.addEvent(
            '*/15 * * * *',
            'sync-customers',
            { limit: 25 },
            'https://example.com/cron'
        )

        expect(executeQuery).toHaveBeenCalledWith({
            sql: expect.stringContaining(
                'INSERT OR REPLACE INTO tmp_cron_tasks'
            ),
            params: [
                'sync-customers',
                '*/15 * * * *',
                JSON.stringify({ limit: 25 }),
                'https://example.com/cron',
            ],
        })
        expect(executeQuery).toHaveBeenCalledWith({
            sql: expect.stringContaining('SELECT name, cron_tab, payload'),
            params: [],
        })
    })

    it('rejects addEvent before the plugin has a data source', async () => {
        await expect(
            plugin.addEvent(
                '* * * * *',
                'uninitialized',
                {},
                'https://example.com'
            )
        ).rejects.toThrow('CronPlugin not properly initialized')
    })
})

describe('CronPlugin - callback route', () => {
    let plugin: CronPlugin

    beforeEach(() => {
        vi.restoreAllMocks()
        plugin = new CronPlugin()
    })

    it('fans out callback payloads and schedules async handlers with waitUntil', async () => {
        const app = createMockApp()
        await plugin.register(app)

        const firstPromise = Promise.resolve('first')
        const secondPromise = Promise.resolve('second')
        const syncCallback = vi.fn()
        const asyncCallback = vi
            .fn()
            .mockReturnValueOnce(firstPromise)
            .mockReturnValueOnce(secondPromise)
        const ctx = {
            waitUntil: vi.fn(),
        } as unknown as ExecutionContext
        const payload: CronEventPayload[] = [
            {
                name: 'sync-customers',
                cron_tab: '* * * * *',
                payload: { limit: 25 },
            },
            {
                name: 'refresh-cache',
                cron_tab: '*/5 * * * *',
                payload: { cacheKey: 'dashboard' },
            },
        ]

        plugin.onEvent(syncCallback)
        plugin.onEvent(asyncCallback, ctx)

        const response = await app.handlers.post?.({
            req: {
                json: vi.fn().mockResolvedValue(payload),
            },
        })

        expect(response?.status).toBe(200)
        await expect(response?.json()).resolves.toEqual({
            result: { success: true },
        })
        expect(syncCallback).toHaveBeenCalledTimes(2)
        expect(syncCallback).toHaveBeenNthCalledWith(1, payload[0])
        expect(syncCallback).toHaveBeenNthCalledWith(2, payload[1])
        expect(asyncCallback).toHaveBeenCalledTimes(2)
        expect(ctx.waitUntil).toHaveBeenNthCalledWith(1, firstPromise)
        expect(ctx.waitUntil).toHaveBeenNthCalledWith(2, secondPromise)
    })
})
