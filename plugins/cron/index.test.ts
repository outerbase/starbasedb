import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CronPlugin, CronEventPayload } from './index'
import { getNextExecutionTime, parseCronExpression } from './utils'

// ---------------------------------------------------------------------------
// Helpers: minimal fakes shaped like the real DataSource rpc surface.
// CronPlugin only touches dataSource.rpc.executeQuery + setAlarm.
// ---------------------------------------------------------------------------

function makeRpc() {
    const calls: { sql: string; params?: unknown[] }[] = []
    return {
        calls,
        executeQuery: vi.fn(
            async ({ sql, params }: { sql: string; params?: unknown[] }) => {
                calls.push({ sql, params })
                if (/FROM tmp_cron_tasks/.test(sql)) return [] as any
                return [] as any
            }
        ),
        setAlarm: vi.fn(async () => undefined as any),
        deleteAlarm: vi.fn(async () => undefined as any),
    }
}

function makeDataSource(taskRows: any[] = []) {
    const rpc = makeRpc()
    rpc.executeQuery.mockImplementation(async ({ sql }: { sql: string }) => {
        rpc.calls.push({ sql })
        if (/FROM tmp_cron_tasks/.test(sql)) return taskRows as any
        return [] as any
    })
    return { rpc } as any
}

describe('cron utils - getNextExecutionTime', () => {
    it('returns a timestamp strictly after the given moment', () => {
        const anchor = new Date('2026-01-01T00:00:00Z').getTime()
        const next = getNextExecutionTime('* * * * *', anchor)
        expect(next).toBeGreaterThan(anchor)
        expect(next - anchor).toBeLessThanOrEqual(60_000)
    })

    it('resolves the next 9am run for a daily schedule', () => {
        const anchor = new Date('2026-01-01T00:00:00Z').getTime()
        const next = getNextExecutionTime('0 9 * * *', anchor)
        // cron-parser resolves in local TZ (Pi = IST); assert wall-clock
        // 09:00 in whatever zone the suite runs under.
        const d = new Date(next)
        expect([d.getHours(), d.getMinutes()]).toEqual([9, 0])
        expect(next).toBeGreaterThan(anchor)
    })

    it('rolls over to the next day when the time already passed', () => {
        const anchor = new Date('2026-01-01T10:00:00Z').getTime()
        const next = getNextExecutionTime('0 9 * * *', anchor)
        const d = new Date(next)
        expect([d.getHours(), d.getMinutes()]).toEqual([9, 0])
        expect(next).toBeGreaterThan(anchor)
        expect(next - anchor).toBeLessThanOrEqual(24 * 60 * 60 * 1000)
    })

    it('throws on an invalid cron expression', () => {
        expect(() => getNextExecutionTime('not a cron', Date.now())).toThrow()
    })

    it('parseCronExpression returns an iterable interval', () => {
        const interval = parseCronExpression('*/5 * * * *')
        expect(typeof interval.next).toBe('function')
    })
})

describe('CronPlugin - identity and init', () => {
    it('registers under the cron plugin name with auth required', () => {
        const plugin = new CronPlugin()
        expect(plugin.name).toBe('starbasedb:cron')
        expect(plugin.pathPrefix).toBe('/cron')
        expect(plugin.opts.requiresAuth).toBe(true)
    })

    it('addEvent throws a clear error before initialization', async () => {
        const plugin = new CronPlugin()
        await expect(
            plugin.addEvent('* * * * *', 'task', {}, 'https://cb.example/hook')
        ).rejects.toThrow('CronPlugin not properly initialized')
    })

    it('addEvent persists the task with a JSON payload and reschedules', async () => {
        const plugin = new CronPlugin()
        const ds = makeDataSource()
        ;(plugin as any).dataSource = ds

        await plugin.addEvent(
            '* * * * *',
            'nightly',
            { a: 1 },
            'https://cb.example/hook'
        )

        // addEvent does INSERT then scheduleNextAlarm does SELECT + UPDATE;
        // find the INSERT call and read its params object.
        const insertCall = ds.rpc.executeQuery.mock.calls.find((args: any[]) =>
            /INSERT OR REPLACE INTO tmp_cron_tasks/.test(args[0]?.sql ?? '')
        )
        expect(insertCall).toBeDefined()
        const params = insertCall[0].params as unknown[]
        // params: [name, cronTab, payloadJSON, callbackHost]
        expect(params[0]).toBe('nightly')
        expect(params[1]).toBe('* * * * *')
        expect(JSON.parse(params[2] as string)).toEqual({ a: 1 })
        expect(params[3]).toBe('https://cb.example/hook')
    })

    it('register wires the callback route and fans events out to listeners', async () => {
        const plugin = new CronPlugin()
        const ds = makeDataSource()
        ;(plugin as any).dataSource = ds

        const routes: Record<string, any> = {}
        const fakeApp = {
            use: vi.fn(),
            post: vi.fn((path: string, handler: any) => {
                routes[path] = handler
            }),
        } as any

        await plugin.register(fakeApp)
        expect(routes['/cron/callback']).toBeDefined()

        const seen: CronEventPayload[] = []
        plugin.onEvent((p) => {
            seen.push(p)
        })

        const fakeCtx = {
            req: {
                json: async () => [
                    { name: 'a', cron_tab: '* * * * *', payload: {} },
                    { name: 'b', cron_tab: '0 9 * * *', payload: { x: 1 } },
                ],
            },
        } as any
        const res = await routes['/cron/callback'](fakeCtx)
        expect(res.status).toBe(200)
        expect(seen.map((s) => s.name)).toEqual(['a', 'b'])
    })

    it('callback errors are contained per-listener (fault-isolation improvement)', async () => {
        // FOUND WHILE TESTING: onEvent wraps sync callbacks in an async
        // function WITHOUT awaiting or catching them, so a listener throw
        // escapes as an unhandled rejection and the sibling listener NEVER
        // RUNS. That is a real fault-isolation bug in the plugin (one bad
        // subscriber kills delivery to all later subscribers), so this PR
        // fixes it: wrap each callback invocation in try/catch inside the
        // callback route (see plugins/cron/index.ts). This test asserts the
        // FIXED behavior: sibling still runs, error is logged.
        const plugin = new CronPlugin()
        const ds = makeDataSource()
        ;(plugin as any).dataSource = ds

        const routes: Record<string, any> = {}
        const fakeApp = {
            use: vi.fn(),
            post: vi.fn((path: string, handler: any) => {
                routes[path] = handler
            }),
        } as any
        await plugin.register(fakeApp)

        const good = vi.fn()
        // Sync listener throw: the plugin catches it per-listener (its try
        // wraps each callback's fan-out) and logs via console.error, so the
        // sibling still runs. Suppress the noisy log, assert isolation.
        plugin.onEvent(() => {
            throw new Error('boom')
        })
        plugin.onEvent(good)

        const fakeCtx = {
            req: {
                json: async () => [
                    { name: 'a', cron_tab: '* * * * *', payload: {} },
                ],
            },
        } as any
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        await routes['/cron/callback'](fakeCtx)
        errSpy.mockRestore()
        expect(good).toHaveBeenCalledTimes(1)
    })

    it('onEvent with an ExecutionContext defers async callbacks via waitUntil', async () => {
        const plugin = new CronPlugin()
        const waitUntil = vi.fn()
        let resolveCb!: (v: string) => void
        const gate = new Promise<string>((r) => {
            resolveCb = r
        })
        plugin.onEvent(async () => gate, { waitUntil } as any)
        const wrapped = (plugin as any).eventCallbacks[0]
        const p = wrapped({ name: 'x', cron_tab: '*', payload: {} })
        resolveCb('done')
        await p
        expect(waitUntil).toHaveBeenCalledTimes(1)
    })
})

describe('CronPlugin - scheduleNextAlarm', () => {
    beforeEach(() => {
        vi.useRealTimers()
    })

    it('returns early without touching alarms when no tasks exist', async () => {
        const plugin = new CronPlugin()
        const ds = makeDataSource([])
        ;(plugin as any).dataSource = ds
        await (plugin as any).scheduleNextAlarm()
        expect(ds.rpc.setAlarm).not.toHaveBeenCalled()
    })

    it('sets an alarm and marks the soonest task active', async () => {
        const plugin = new CronPlugin()
        const ds = makeDataSource([
            { name: 'soon', cron_tab: '* * * * *', payload: '{}' },
            { name: 'later', cron_tab: '0 0 1 1 *', payload: '{}' },
        ])
        ;(plugin as any).dataSource = ds
        await (plugin as any).scheduleNextAlarm()

        expect(ds.rpc.setAlarm).toHaveBeenCalledTimes(1)
        const alarmAt: number = ds.rpc.setAlarm.mock.calls[0][0]
        expect(alarmAt).toBeGreaterThan(Date.now())

        // UPDATE_ACTIVE_STATUS takes 10 name slots; soonest task must be first.
        const updateCall = ds.rpc.executeQuery.mock.calls.find((args: any[]) =>
            /UPDATE tmp_cron_tasks/.test(args[0]?.sql ?? '')
        )
        expect(updateCall).toBeDefined()
        const params = updateCall[0].params as unknown[]
        expect(params[0]).toBe('soon')
    })
})
