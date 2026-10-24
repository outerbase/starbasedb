import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CronPlugin, CronEventPayload } from './index'
import { StarbaseApp } from '../../src/handler'
import { DataSource } from '../../src/types'

let cronPlugin: CronPlugin
let mockDataSource: DataSource
let mockExecutionContext: ExecutionContext

beforeEach(() => {
    vi.clearAllMocks()

    mockExecutionContext = {
        waitUntil: vi.fn(),
    } as unknown as ExecutionContext

    mockDataSource = {
        rpc: {
            executeQuery: vi.fn().mockResolvedValue([]),
            setAlarm: vi.fn().mockResolvedValue(true),
        },
    } as unknown as DataSource

    cronPlugin = new CronPlugin()
})

describe('CronPlugin - Initialization', () => {
    it('should initialize with correct name and auth requirements', () => {
        expect(cronPlugin).toBeInstanceOf(CronPlugin)
        expect(cronPlugin.name).toBe('starbasedb:cron')
        expect(cronPlugin.pathPrefix).toBe('/cron')
        expect(cronPlugin.opts.requiresAuth).toBe(true)
    })
})

describe('CronPlugin - register() and Middleware', () => {
    it('should set up middleware that initializes table and schedules alarms', async () => {
        let middlewareHandler: any = null
        const mockApp = {
            use: vi.fn((fn) => {
                middlewareHandler = fn
            }),
            post: vi.fn(),
        } as unknown as StarbaseApp

        await cronPlugin.register(mockApp)

        expect(mockApp.use).toHaveBeenCalledTimes(1)
        expect(mockApp.post).toHaveBeenCalledWith(
            '/cron/callback',
            expect.any(Function)
        )

        const mockContext = {
            get: vi.fn(() => mockDataSource),
        }
        const mockNext = vi.fn().mockResolvedValue(undefined)

        await middlewareHandler(mockContext, mockNext)

        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: expect.stringContaining(
                'CREATE TABLE IF NOT EXISTS tmp_cron_tasks'
            ),
            params: [],
        })
        expect(mockNext).toHaveBeenCalledTimes(1)
    })

    it('should handle POST /cron/callback and invoke registered callbacks', async () => {
        let postHandler: any = null
        const mockApp = {
            use: vi.fn(),
            post: vi.fn((path, handler) => {
                if (path === '/cron/callback') {
                    postHandler = handler
                }
            }),
        } as unknown as StarbaseApp

        await cronPlugin.register(mockApp)

        const sampleEvent: CronEventPayload = {
            name: 'cleanup_job',
            cron_tab: '0 * * * *',
            payload: { dryRun: false },
        }

        const receivedPayloads: CronEventPayload[] = []
        cronPlugin.onEvent((evt) => {
            receivedPayloads.push(evt)
        })

        const mockReqContext = {
            req: {
                json: vi.fn().mockResolvedValue([sampleEvent]),
            },
        }

        const response = await postHandler(mockReqContext)
        expect(response.status).toBe(200)
        expect(receivedPayloads).toHaveLength(1)
        expect(receivedPayloads[0].name).toBe('cleanup_job')
    })
})

describe('CronPlugin - addEvent()', () => {
    it('should throw an error when called before dataSource is initialized', async () => {
        await expect(
            cronPlugin.addEvent(
                '* * * * *',
                'task_1',
                {},
                'https://api.example.com'
            )
        ).rejects.toThrow('CronPlugin not properly initialized')
    })

    it('should insert task into database and reschedule next alarm', async () => {
        // Manually assign dataSource for unit test
        cronPlugin['dataSource'] = mockDataSource

        // Mock executeQuery for GET_TASKS to return the newly added task
        ;(mockDataSource.rpc.executeQuery as any).mockImplementation(
            ({ sql }: any) => {
                if (sql.includes('SELECT name, cron_tab, payload')) {
                    return [
                        {
                            name: 'sync_data',
                            cron_tab: '*/10 * * * *',
                            payload: '{"target":"db"}',
                        },
                    ]
                }
                return []
            }
        )

        await cronPlugin.addEvent(
            '*/10 * * * *',
            'sync_data',
            { target: 'db' },
            'https://api.example.com'
        )

        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: expect.stringContaining(
                'INSERT OR REPLACE INTO tmp_cron_tasks'
            ),
            params: [
                'sync_data',
                '*/10 * * * *',
                JSON.stringify({ target: 'db' }),
                'https://api.example.com',
            ],
        })

        expect(mockDataSource.rpc.setAlarm).toHaveBeenCalledWith(
            expect.any(Number)
        )
    })
})

describe('CronPlugin - onEvent() with ExecutionContext', () => {
    it('should route async promise to ctx.waitUntil', async () => {
        let asyncFinished = false
        const asyncCallback = async () => {
            await new Promise((res) => setTimeout(res, 10))
            asyncFinished = true
        }

        cronPlugin.onEvent(asyncCallback, mockExecutionContext)

        // Invoke callback wrapper directly
        const sampleEvent: CronEventPayload = {
            name: 'test',
            cron_tab: '* * * * *',
            payload: {},
        }

        const registeredCallback = cronPlugin['eventCallbacks'][0]
        await registeredCallback(sampleEvent)

        expect(mockExecutionContext.waitUntil).toHaveBeenCalledWith(
            expect.any(Promise)
        )
    })
})
