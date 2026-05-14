import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CronEventPayload, CronPlugin } from './index'
import { getNextExecutionTime, parseCronExpression } from './utils'
import { StarbaseApp } from '../../src/handler'
import { DataSource } from '../../src/types'

type MockApp = StarbaseApp & {
    capturedMiddleware?: (c: any, next: () => Promise<void>) => Promise<void>
    capturedPostHandler?: (c: any) => Promise<Response>
}

let cronPlugin: CronPlugin
let mockDataSource: DataSource

const createMockApp = () => {
    const app = {
        use: vi.fn((middleware) => {
            app.capturedMiddleware = middleware
        }),
        post: vi.fn((_path, handler) => {
            app.capturedPostHandler = handler
        }),
    } as MockApp

    return app
}

let mockApp: MockApp

beforeEach(() => {
    vi.clearAllMocks()

    mockDataSource = {
        rpc: {
            executeQuery: vi.fn().mockResolvedValue([]),
            setAlarm: vi.fn().mockResolvedValue(undefined),
        },
    } as unknown as DataSource

    cronPlugin = new CronPlugin()
    mockApp = createMockApp()
})

afterEach(() => {
    vi.restoreAllMocks()
})

describe('Cron utils', () => {
    it('should parse valid cron expressions', () => {
        const interval = parseCronExpression('*/5 * * * *')

        expect(interval.next().getTime()).toEqual(expect.any(Number))
    })

    it('should calculate the next execution time after a timestamp', () => {
        const after = new Date('2026-05-14T10:00:00.000Z').getTime()

        const nextExecution = getNextExecutionTime('*/15 * * * *', after)

        expect(nextExecution).toBe(
            new Date('2026-05-14T10:15:00.000Z').getTime()
        )
    })
})

describe('CronPlugin - Initialization', () => {
    it('should initialize with default values', () => {
        expect(cronPlugin).toBeInstanceOf(CronPlugin)
        expect(cronPlugin.pathPrefix).toBe('/cron')
        expect(cronPlugin['eventCallbacks']).toHaveLength(0)
    })
})

describe('CronPlugin - register()', () => {
    it('should create the cron table and schedule alarms from middleware', async () => {
        const next = vi.fn().mockResolvedValue(undefined)

        await cronPlugin.register(mockApp)
        await mockApp.capturedMiddleware?.(
            { get: vi.fn(() => mockDataSource) },
            next
        )

        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: expect.stringContaining(
                'CREATE TABLE IF NOT EXISTS tmp_cron_tasks'
            ),
            params: [],
        })
        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: expect.stringContaining('SELECT name, cron_tab, payload'),
            params: [],
        })
        expect(next).toHaveBeenCalledTimes(1)
    })

    it('should register a callback endpoint under the cron prefix', async () => {
        await cronPlugin.register(mockApp)

        expect(mockApp.post).toHaveBeenCalledWith(
            '/cron/callback',
            expect.any(Function)
        )
    })
})

describe('CronPlugin - scheduleNextAlarm()', () => {
    it('should leave alarms untouched when no cron tasks exist', async () => {
        cronPlugin['dataSource'] = mockDataSource

        await cronPlugin['scheduleNextAlarm']()

        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: expect.stringContaining('SELECT name, cron_tab, payload'),
            params: [],
        })
        expect(mockDataSource.rpc.setAlarm).not.toHaveBeenCalled()
    })

    it('should activate all tasks that share the earliest next execution time', async () => {
        const now = new Date('2026-05-14T10:00:00.000Z').getTime()
        vi.spyOn(Date, 'now').mockReturnValue(now)
        vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValueOnce([
            {
                name: 'sync-customers',
                cron_tab: '*/5 * * * *',
                payload: '{}',
            },
            {
                name: 'sync-orders',
                cron_tab: '*/5 * * * *',
                payload: '{}',
            },
            {
                name: 'daily-report',
                cron_tab: '0 11 * * *',
                payload: '{}',
            },
        ])
        cronPlugin['dataSource'] = mockDataSource

        await cronPlugin['scheduleNextAlarm']()

        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: expect.stringContaining('UPDATE tmp_cron_tasks'),
            params: [
                'sync-customers',
                'sync-orders',
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
        expect(mockDataSource.rpc.setAlarm).toHaveBeenCalledWith(
            new Date('2026-05-14T10:05:00.000Z').getTime()
        )
    })
})

describe('CronPlugin - addEvent()', () => {
    it('should insert the event payload and reschedule alarms', async () => {
        vi.mocked(mockDataSource.rpc.executeQuery)
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([])
        cronPlugin['dataSource'] = mockDataSource

        await cronPlugin.addEvent(
            '*/10 * * * *',
            'lead-sync',
            {
                source: 'crm',
            },
            'https://example.com/cron'
        )

        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: expect.stringContaining(
                'INSERT OR REPLACE INTO tmp_cron_tasks'
            ),
            params: [
                'lead-sync',
                '*/10 * * * *',
                JSON.stringify({ source: 'crm' }),
                'https://example.com/cron',
            ],
        })
        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: expect.stringContaining('SELECT name, cron_tab, payload'),
            params: [],
        })
    })

    it('should throw when the plugin has not been initialized', async () => {
        await expect(
            cronPlugin.addEvent('*/10 * * * *', 'lead-sync', {}, '')
        ).rejects.toThrow('CronPlugin not properly initialized')
    })
})

describe('CronPlugin - onEvent()', () => {
    it('should dispatch callback payloads through the callback route', async () => {
        const callback = vi.fn()
        const payload: CronEventPayload[] = [
            {
                name: 'sync-customers',
                cron_tab: '*/5 * * * *',
                payload: { source: 'crm' },
            },
            {
                name: 'sync-orders',
                cron_tab: '*/5 * * * *',
                payload: { source: 'shop' },
            },
        ]
        cronPlugin.onEvent(callback)
        await cronPlugin.register(mockApp)

        const response = await mockApp.capturedPostHandler?.({
            req: { json: vi.fn().mockResolvedValue(payload) },
        })

        expect(callback).toHaveBeenCalledTimes(2)
        expect(callback).toHaveBeenNthCalledWith(1, payload[0])
        expect(callback).toHaveBeenNthCalledWith(2, payload[1])
        await expect(response?.json()).resolves.toEqual({
            result: { success: true },
        })
    })

    it('should schedule async callbacks with waitUntil when context is provided', async () => {
        const waitUntil = vi.fn()
        const callback = vi.fn().mockResolvedValue(undefined)
        const payload: CronEventPayload = {
            name: 'sync-customers',
            cron_tab: '*/5 * * * *',
            payload: { source: 'crm' },
        }
        cronPlugin.onEvent(callback, {
            waitUntil,
        } as unknown as ExecutionContext)

        await cronPlugin['eventCallbacks'][0](payload)

        expect(callback).toHaveBeenCalledWith(payload)
        expect(waitUntil).toHaveBeenCalledWith(expect.any(Promise))
    })
})
