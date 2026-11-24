import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CronPlugin } from './index'
import { getNextExecutionTime } from './utils'
import { StarbaseApp } from '../../src/handler'
import { DataSource, QueryResult } from '../../src/types'

const NOW = new Date('2026-06-01T12:00:00Z').getTime()

describe('cron utils - getNextExecutionTime', () => {
    it('should return the next matching minute for a cron expression', () => {
        const next = getNextExecutionTime('* * * * *', NOW)
        expect(next).toBe(NOW + 60 * 1000)
    })

    it('should return a time strictly in the future', () => {
        const next = getNextExecutionTime('0 0 * * *', NOW)
        expect(next).toBeGreaterThan(NOW)
    })

    it('should reject an invalid cron expression', () => {
        expect(() => getNextExecutionTime('not a cron', NOW)).toThrow()
    })
})

function createMockDataSource(tasks: QueryResult[] = []) {
    return {
        rpc: {
            executeQuery: vi.fn().mockResolvedValue(tasks),
            setAlarm: vi.fn().mockResolvedValue(undefined),
        },
    } as unknown as DataSource
}

type RegisteredHandler = (...args: any[]) => Promise<any>

function createMockApp(dataSource?: DataSource) {
    const handlers: Record<string, RegisteredHandler[]> = {}
    const middlewares: RegisteredHandler[] = []
    const context = {
        get: vi.fn((key: string) =>
            key === 'dataSource' ? dataSource : undefined
        ),
    }

    const app = {
        use: vi.fn((middleware: RegisteredHandler) => {
            middlewares.push(middleware)
        }),
        post: vi.fn((path: string, handler: RegisteredHandler) => {
            handlers[path] = handlers[path] || []
            handlers[path].push(handler)
        }),
        get: vi.fn((path: string, handler: RegisteredHandler) => {
            handlers[path] = handlers[path] || []
            handlers[path].push(handler)
        }),
    } as unknown as StarbaseApp

    return { app, handlers, middlewares, context }
}

async function runMiddlewares(plugin: CronPlugin, app: ReturnType<typeof createMockApp>) {
    await plugin.register(app.app as StarbaseApp)
    for (const middleware of app.middlewares) {
        await middleware(app.context as any, vi.fn())
    }
}

afterEach(() => {
    vi.useRealTimers()
})

describe('CronPlugin - Initialization', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        vi.setSystemTime(NOW)
    })
    it('should initialize with the cron prefix and require auth', () => {
        const plugin = new CronPlugin()
        expect(plugin.pathPrefix).toBe('/cron')
        expect(plugin.opts.requiresAuth).toBe(true)
    })
})

describe('CronPlugin - register()', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        vi.setSystemTime(NOW)
    })

    it('should create the tmp_cron_tasks table when a data source is available', async () => {
        const dataSource = createMockDataSource()
        const app = createMockApp(dataSource)

        await runMiddlewares(new CronPlugin(), app)

        expect(dataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: expect.stringContaining('CREATE TABLE IF NOT EXISTS tmp_cron_tasks'),
            params: [],
        })
    })

    it('should not touch the data source when none is provided', async () => {
        const plugin = new CronPlugin()
        const app = createMockApp(undefined)
        await plugin.register(app.app as StarbaseApp)

        for (const middleware of app.middlewares) {
            await expect(middleware(app.context as any, vi.fn())).resolves.toBeUndefined()
        }
    })

    it('should schedule an alarm at the earliest next execution time across tasks', async () => {
        // A task firing at the next minute boundary, and one firing daily at midnight.
        const soon = getNextExecutionTime('* * * * *', NOW)
        const daily = getNextExecutionTime('0 0 * * *', NOW)
        expect(soon).toBeLessThan(daily)

        const dataSource = createMockDataSource([
            { name: 'every-minute', cron_tab: '* * * * *', payload: '{}' },
            { name: 'daily', cron_tab: '0 0 * * *', payload: '{}' },
        ] as QueryResult[])
        const app = createMockApp(dataSource)

        await runMiddlewares(new CronPlugin(), app)

        expect(dataSource.rpc.setAlarm).toHaveBeenCalledTimes(1)
        expect(dataSource.rpc.setAlarm).toHaveBeenCalledWith(soon)
    })

    it('should pad the active-status update to exactly ten task name slots', async () => {
        const dataSource = createMockDataSource([
            { name: 'only-task', cron_tab: '* * * * *', payload: '{}' },
        ] as QueryResult[])
        const app = createMockApp(dataSource)

        await runMiddlewares(new CronPlugin(), app)

        const updateCall = dataSource.rpc.executeQuery.mock.calls.find(
            ([{ sql }]: any) => sql.includes('UPDATE tmp_cron_tasks')
        )
        expect(updateCall).toBeDefined()
        expect(updateCall[0].params).toHaveLength(10)
        expect(updateCall[0].params[0]).toBe('only-task')
        expect(updateCall[0].params.slice(1)).toEqual(Array(9).fill(null))
    })

    it('should not set an alarm when no tasks exist', async () => {
        const dataSource = createMockDataSource([])
        const app = createMockApp(dataSource)

        await runMiddlewares(new CronPlugin(), app)

        expect(dataSource.rpc.setAlarm).not.toHaveBeenCalled()
    })
})

describe('CronPlugin - addEvent()', () => {
    beforeEach(() => {
        vi.useFakeTimers()
        vi.setSystemTime(NOW)
    })

    it('should insert a task and reschedule the alarm', async () => {
        const dataSource = createMockDataSource()
        const plugin = new CronPlugin()
        const app = createMockApp(dataSource)
        await runMiddlewares(plugin, app)
        // After registration, return an existing task for GET_TASKS so the
        // reschedule pass has something to schedule an alarm for.
        dataSource.rpc.executeQuery.mockResolvedValue([
            { name: 'my-task', cron_tab: '* * * * *', payload: '{}' },
        ])

        await plugin.addEvent('* * * * *', 'my-task', { foo: 'bar' }, 'https://callback.host')

        expect(dataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: expect.stringContaining('INSERT OR REPLACE INTO tmp_cron_tasks'),
            params: ['my-task', '* * * * *', '{"foo":"bar"}', 'https://callback.host'],
        })
        expect(dataSource.rpc.setAlarm).toHaveBeenCalled()
    })

    it('should reject adding events before the plugin has a data source', async () => {
        const plugin = new CronPlugin()
        await expect(
            plugin.addEvent('* * * * *', 'my-task', {}, 'https://callback.host')
        ).rejects.toThrow('CronPlugin not properly initialized')
    })
})

describe('CronPlugin - callback route and event callbacks', () => {
    it('should notify every registered listener with each payload element', async () => {
        const plugin = new CronPlugin()
        const app = createMockApp(createMockDataSource())
        await plugin.register(app.app as StarbaseApp)

        const first = vi.fn()
        const second = vi.fn()
        plugin.onEvent(first)
        plugin.onEvent(second)

        const handler = app.handlers['/cron/callback'][0]
        const response = await handler({
            req: {
                json: vi.fn().mockResolvedValue([
                    { name: 'task-a', cron_tab: '* * * * *', payload: { n: 1 } },
                    { name: 'task-b', cron_tab: '* * * * *', payload: { n: 2 } },
                ]),
            },
        })

        expect(first).toHaveBeenCalledTimes(2)
        expect(second).toHaveBeenCalledTimes(2)
        expect(first).toHaveBeenNthCalledWith(1, {
            name: 'task-a',
            cron_tab: '* * * * *',
            payload: { n: 1 },
        })
        const body = await response.json()
        expect(body.result).toEqual({ success: true })
    })

    it('should keep dispatching when one listener throws', async () => {
        const plugin = new CronPlugin()
        const app = createMockApp(createMockDataSource())
        await plugin.register(app.app as StarbaseApp)

        // Listener errors surface as rejections of the wrapped async callback;
        // capture the unhandled rejection instead of letting it fail the run.
        const unhandled: unknown[] = []
        const rejectionHandler = (reason: unknown) => unhandled.push(reason)
        process.on('unhandledRejection', rejectionHandler)

        const failing = vi.fn(() => {
            throw new Error('listener exploded')
        })
        const healthy = vi.fn()
        plugin.onEvent(failing as any)
        plugin.onEvent(healthy)

        try {
            const handler = app.handlers['/cron/callback'][0]
            const response = await handler({
                req: {
                    json: vi.fn().mockResolvedValue([
                        { name: 'task-a', cron_tab: '* * * * *', payload: {} },
                    ]),
                },
            })

            expect(failing).toHaveBeenCalledTimes(1)
            expect(healthy).toHaveBeenCalledTimes(1)
            expect(response.status).toBe(200)
            await new Promise((resolve) => setImmediate(resolve))
            expect(
                unhandled.some(
                    (e) => e instanceof Error && e.message === 'listener exploded'
                )
            ).toBe(true)
        } finally {
            process.off('unhandledRejection', rejectionHandler)
        }
    })

    it('should wrap async listeners with the execution context via waitUntil', async () => {
        const plugin = new CronPlugin()
        const app = createMockApp(createMockDataSource())
        await plugin.register(app.app as StarbaseApp)

        const waitUntil = vi.fn()
        const asyncListener = vi.fn().mockResolvedValue(undefined)
        plugin.onEvent(asyncListener, { waitUntil } as any)

        const handler = app.handlers['/cron/callback'][0]
        await handler({
            req: {
                json: vi.fn().mockResolvedValue([
                    { name: 'task-a', cron_tab: '* * * * *', payload: {} },
                ]),
            },
        })

        expect(waitUntil).toHaveBeenCalledTimes(1)
    })
})
