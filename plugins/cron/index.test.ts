import { describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { CronPlugin, CronEventPayload } from './index'
import { getNextExecutionTime, parseCronExpression } from './utils'

describe('CronPlugin & Cron Utils (plugins/cron)', () => {
    it('parses cron expressions and computes next execution timestamp', () => {
        const parsed = parseCronExpression('*/5 * * * *')
        expect(parsed).toBeDefined()

        const baseTime = new Date('2026-01-01T00:00:00Z').getTime()
        const nextMs = getNextExecutionTime('*/5 * * * *', baseTime)
        expect(nextMs).toBe(new Date('2026-01-01T00:05:00Z').getTime())
    })

    it('registers routes, schedules next alarm on addEvent, and dispatches /cron/callback events', async () => {
        const storedTasks: Array<{
            name: string
            cron_tab: string
            payload: string
        }> = []
        const setAlarmMock = vi.fn(async () => {})
        const executeQueryMock = vi.fn(async ({ sql, params }: { sql: string; params?: any[] }) => {
            if (sql.includes('INSERT OR REPLACE INTO tmp_cron_tasks') && params) {
                storedTasks.push({
                    name: params[0],
                    cron_tab: params[1],
                    payload: params[2],
                })
                return []
            }
            if (sql.includes('SELECT name, cron_tab, payload')) {
                return storedTasks
            }
            return []
        })

        const mockDataSource = {
            source: 'internal',
            rpc: {
                executeQuery: executeQueryMock,
                setAlarm: setAlarmMock,
            },
        }

        const app = new Hono<any>()
        app.use('*', async (c, next) => {
            c.set('dataSource', mockDataSource)
            await next()
        })

        const plugin = new CronPlugin()
        await plugin.register(app as any)

        const receivedEvents: CronEventPayload[] = []
        const waitUntilMock = vi.fn()
        plugin.onEvent(
            async (payload) => {
                receivedEvents.push(payload)
            },
            { waitUntil: waitUntilMock } as any
        )

        // Trigger middleware to initialize plugin dataSource
        const res = await app.request('/cron/callback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify([
                {
                    name: 'hourly-sync',
                    cron_tab: '0 * * * *',
                    payload: { target: 'analytics' },
                },
            ]),
        })

        expect(res.status).toBe(200)
        expect(receivedEvents).toHaveLength(1)
        expect(receivedEvents[0].name).toBe('hourly-sync')
        expect(waitUntilMock).toHaveBeenCalledTimes(1)

        await plugin.addEvent('*/10 * * * *', 'cleanup-job', { dryRun: false }, 'https://example.com')
        expect(setAlarmMock).toHaveBeenCalledTimes(1)
    })
})
