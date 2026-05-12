import { Hono } from 'hono'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { CronPlugin, CronEventPayload } from './index'
import { getNextExecutionTime } from './utils'

const createMockDataSource = (tasks: Record<string, unknown>[] = []) => ({
    rpc: {
        executeQuery: vi.fn().mockImplementation(({ sql }) => {
            if (sql.includes('SELECT name, cron_tab, payload')) {
                return Promise.resolve(tasks)
            }

            return Promise.resolve([])
        }),
        setAlarm: vi.fn().mockResolvedValue(undefined),
    },
})

async function createApp(dataSource: ReturnType<typeof createMockDataSource>) {
    const app = new Hono()
    const plugin = new CronPlugin()

    app.use(async (c, next) => {
        ;(c as any).set('dataSource', dataSource)
        await next()
    })

    await plugin.register(app as any)

    return { app, plugin }
}

describe('CronPlugin', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-05-13T00:00:00.000Z'))
    })

    afterEach(() => {
        vi.useRealTimers()
        vi.restoreAllMocks()
    })

    it('initializes with cron metadata and auth required', () => {
        const plugin = new CronPlugin()

        expect(plugin.name).toBe('starbasedb:cron')
        expect(plugin.pathPrefix).toBe('/cron')
        expect(plugin.opts.requiresAuth).toBe(true)
    })

    it('computes the next execution time after the provided timestamp', () => {
        const after = Date.parse('2026-05-13T00:00:30.000Z')

        expect(getNextExecutionTime('* * * * *', after)).toBe(
            Date.parse('2026-05-13T00:01:00.000Z')
        )
    })

    it('rejects addEvent before request middleware initializes a data source', async () => {
        const plugin = new CronPlugin()

        await expect(
            plugin.addEvent(
                '* * * * *',
                'daily-report',
                {},
                'https://host.test'
            )
        ).rejects.toThrow('CronPlugin not properly initialized')
    })

    it('creates the cron table during request middleware without scheduling empty task sets', async () => {
        const dataSource = createMockDataSource()
        const { app } = await createApp(dataSource)

        const response = await app.request('/missing-route')

        expect(response.status).toBe(404)
        expect(dataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: expect.stringContaining(
                'CREATE TABLE IF NOT EXISTS tmp_cron_tasks'
            ),
            params: [],
        })
        expect(dataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: expect.stringContaining('SELECT name, cron_tab, payload'),
            params: [],
        })
        expect(dataSource.rpc.setAlarm).not.toHaveBeenCalled()
    })

    it('marks the nearest cron tasks active and schedules the alarm', async () => {
        const dataSource = createMockDataSource([
            {
                name: 'hourly-job',
                cron_tab: '0 * * * *',
                payload: '{}',
            },
            {
                name: 'next-minute-job',
                cron_tab: '* * * * *',
                payload: '{}',
            },
            {
                name: 'also-next-minute',
                cron_tab: '* * * * *',
                payload: '{}',
            },
        ])
        const plugin = new CronPlugin()
        ;(plugin as any).dataSource = dataSource

        await (plugin as any).scheduleNextAlarm()

        expect(dataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: expect.stringContaining('UPDATE tmp_cron_tasks'),
            params: [
                'next-minute-job',
                'also-next-minute',
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
            Date.parse('2026-05-13T00:01:00.000Z')
        )
    })

    it('inserts a cron event payload and reschedules alarms', async () => {
        const dataSource = createMockDataSource([
            {
                name: 'weekly-summary',
                cron_tab: '* * * * *',
                payload: '{"team":"ops"}',
            },
        ])
        const plugin = new CronPlugin()
        ;(plugin as any).dataSource = dataSource

        await plugin.addEvent(
            '* * * * *',
            'weekly-summary',
            { team: 'ops' },
            'https://example.com/cron'
        )

        expect(dataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: expect.stringContaining(
                'INSERT OR REPLACE INTO tmp_cron_tasks'
            ),
            params: [
                'weekly-summary',
                '* * * * *',
                JSON.stringify({ team: 'ops' }),
                'https://example.com/cron',
            ],
        })
        expect(dataSource.rpc.setAlarm).toHaveBeenCalledWith(
            Date.parse('2026-05-13T00:01:00.000Z')
        )
    })

    it('dispatches callback payloads and returns a successful response', async () => {
        const dataSource = createMockDataSource()
        const { app, plugin } = await createApp(dataSource)
        const callback = vi.fn()
        const payload: CronEventPayload[] = [
            {
                name: 'first',
                cron_tab: '* * * * *',
                payload: { count: 1 },
            },
            {
                name: 'second',
                cron_tab: '0 * * * *',
                payload: { count: 2 },
            },
        ]

        plugin.onEvent(callback)

        const response = await app.request('/cron/callback', {
            method: 'POST',
            body: JSON.stringify(payload),
            headers: { 'Content-Type': 'application/json' },
        })

        expect(response.status).toBe(200)
        await expect(response.json()).resolves.toEqual({
            result: { success: true },
        })
        expect(callback).toHaveBeenCalledTimes(2)
        expect(callback).toHaveBeenNthCalledWith(1, payload[0])
        expect(callback).toHaveBeenNthCalledWith(2, payload[1])
    })

    it('passes asynchronous event handlers to the execution context', async () => {
        const plugin = new CronPlugin()
        const waitUntil = vi.fn()
        const promise = Promise.resolve()
        const callback = vi.fn().mockReturnValue(promise)
        const payload: CronEventPayload = {
            name: 'async-job',
            cron_tab: '* * * * *',
            payload: {},
        }

        plugin.onEvent(callback, { waitUntil } as unknown as ExecutionContext)

        await (plugin as any).eventCallbacks[0](payload)

        expect(callback).toHaveBeenCalledWith(payload)
        expect(waitUntil).toHaveBeenCalledWith(promise)
    })
})
