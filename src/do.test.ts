import { describe, expect, it, vi, beforeEach } from 'vitest'
import { StarbaseDBDurableObject } from './do'

vi.mock('cloudflare:workers', () => {
    return {
        DurableObject: class MockDurableObject {},
    }
})

declare global {
    var WebSocket: {
        new (url: string, protocols?: string | string[]): WebSocket
        prototype: WebSocket
        readonly READY_STATE_CONNECTING: number
        readonly CONNECTING: number
        readonly READY_STATE_OPEN: number
        readonly OPEN: number
        readonly READY_STATE_CLOSING: number
        readonly CLOSING: number
        readonly READY_STATE_CLOSED: number
        readonly CLOSED: number
    }
    var Response: typeof globalThis.Response
}

global.WebSocket = class {
    static READY_STATE_CONNECTING = 0
    static READY_STATE_OPEN = 1
    static READY_STATE_CLOSING = 2
    static READY_STATE_CLOSED = 3
    static CONNECTING = 0
    static OPEN = 1
    static CLOSING = 2
    static CLOSED = 3

    readyState = global.WebSocket.CONNECTING
    send = vi.fn()
    close = vi.fn()
    accept = vi.fn()
    addEventListener = vi.fn()
}

global.WebSocketPair = vi.fn(() => {
    const client = new global.WebSocket('ws://localhost')
    const server = new global.WebSocket('ws://localhost')
    server.accept = vi.fn()
    return { 0: client, 1: server }
})

global.Response = class {
    body: any
    status: any
    webSocket: any
    constructor(body?: any, init?: any) {
        this.body = body
        this.status = init?.status ?? 200
        this.webSocket = init?.webSocket
    }
}

const mockStorage = {
    sql: {
        exec: vi.fn().mockReturnValue({
            columnNames: ['id', 'name'],
            raw: vi.fn().mockReturnValue([
                [1, 'Alice'],
                [2, 'Bob'],
            ]),
            toArray: vi.fn().mockReturnValue([
                { id: 1, name: 'Alice' },
                { id: 2, name: 'Bob' },
            ]),
            rowsRead: 2,
            rowsWritten: 1,
        }),
    },
}

const mockDurableObjectState = {
    storage: mockStorage,
    getTags: vi.fn().mockReturnValue(['session-123']),
} as any

const mockEnv = {} as any

let instance: StarbaseDBDurableObject

beforeEach(() => {
    instance = new StarbaseDBDurableObject(mockDurableObjectState, mockEnv)
    vi.clearAllMocks()
})

describe('StarbaseDBDurableObject Tests', () => {
    it('should initialize SQL storage', () => {
        expect(instance.sql).toBeDefined()
        expect(instance.storage).toBeDefined()
    })

    it('should execute a query and return results', async () => {
        const sql = 'SELECT * FROM users'
        const result = await instance.executeQuery({ sql })

        expect(mockStorage.sql.exec).toHaveBeenCalledWith(sql)
        expect(result).toEqual([
            { id: 1, name: 'Alice' },
            { id: 2, name: 'Bob' },
        ])
    })

    it('should execute a transaction and return results', async () => {
        const queries = [
            { sql: 'SELECT * FROM orders' },
            { sql: 'SELECT * FROM products' },
        ]
        const result = await instance.executeTransaction(queries, false)

        expect(mockStorage.sql.exec).toHaveBeenCalledTimes(2)
        expect(result.length).toBe(2)
    })

    it('should handle WebSocket connections', async () => {
        const response = await instance.clientConnected('session-123')

        expect(response.status).toBe(101)
        expect(instance.connections.has('session-123')).toBe(true)
    })

    it('should return 400 for unknown fetch requests', async () => {
        const request = new Request('https://example.com/unknown')
        const response = await instance.fetch(request)

        expect(response.status).toBe(400)
    })

    it('should handle errors in executeQuery', async () => {
        const consoleErrorSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {}) // ✅ Suppress error logs

        mockStorage.sql.exec.mockImplementationOnce(() => {
            throw new Error('Query failed')
        })

        await expect(
            instance.executeQuery({ sql: 'INVALID QUERY' })
        ).rejects.toThrow('Query failed')
    })

    it('should mark active dump job failed in alarm() if DUMP_BUCKET is not bound and ignore missing tmp_cron_tasks', async () => {
        const setAlarmMock = vi.fn()
        const stateWithAlarm = {
            storage: {
                ...mockStorage,
                setAlarm: setAlarmMock,
                getAlarm: vi.fn().mockResolvedValue(null),
                deleteAlarm: vi.fn(),
            },
            getTags: vi.fn().mockReturnValue([]),
        } as any

        const doInstance = new StarbaseDBDurableObject(
            stateWithAlarm,
            {} as any
        )
        const executedSql: string[] = []

        vi.spyOn(doInstance, 'executeQuery').mockImplementation(
            async (opts: { sql: string; params?: unknown[] }) => {
                executedSql.push(opts.sql)
                if (opts.sql.includes('FROM tmp_dump_jobs')) {
                    return [
                        {
                            id: 'job-no-r2',
                            status: 'in_progress',
                            r2_key: 'dump_20240101-170000.sql',
                        },
                    ] as any
                }
                if (opts.sql.includes('FROM tmp_cron_tasks')) {
                    throw new Error('no such table: tmp_cron_tasks')
                }
                return [] as any
            }
        )

        await doInstance.alarm()

        expect(
            executedSql.some((s) =>
                s.includes("UPDATE tmp_dump_jobs SET status = 'failed'")
            )
        ).toBe(true)
        // Must NOT schedule spurious 60s recovery alarm when tmp_cron_tasks does not exist
        expect(setAlarmMock).not.toHaveBeenCalled()
    })

    it('should continue an active dump job in alarm() when DUMP_BUCKET is bound', async () => {
        const setAlarmMock = vi.fn()
        const stateWithAlarm = {
            storage: {
                ...mockStorage,
                setAlarm: setAlarmMock,
                getAlarm: vi.fn().mockResolvedValue(null),
                deleteAlarm: vi.fn(),
            },
            getTags: vi.fn().mockReturnValue([]),
        } as any

        const completedParts: R2UploadedPart[] = []
        const mockBucket = {
            resumeMultipartUpload: vi.fn(() => ({
                uploadPart: vi.fn(async (partNumber: number) => {
                    const part = { partNumber, etag: `e-${partNumber}` }
                    completedParts.push(part)
                    return part
                }),
                complete: vi.fn(async () => ({
                    key: 'dump_20240101-170000.sql',
                })),
                abort: vi.fn(),
            })),
            get: vi.fn(),
            put: vi.fn(),
            delete: vi.fn(),
        } as unknown as R2Bucket

        const doInstance = new StarbaseDBDurableObject(stateWithAlarm, {
            DUMP_BUCKET: mockBucket,
        } as any)

        let updatedStatus = ''
        vi.spyOn(doInstance, 'executeQuery').mockImplementation(
            async (opts: { sql: string; params?: unknown[] }) => {
                if (
                    opts.sql.includes('SELECT * FROM tmp_dump_jobs') &&
                    opts.sql.includes("status IN ('pending', 'in_progress')")
                ) {
                    return [
                        {
                            id: 'job-alarm-1',
                            status: 'in_progress',
                            r2_key: 'dump_20240101-170000.sql',
                            upload_id: 'u-1',
                            tables_json: JSON.stringify(['users']),
                            table_index: 0,
                            row_offset: 0,
                            schema_emitted: 0,
                            parts_json: '[]',
                            pending_buffer: btoa('SQLite format 3\0'),
                            pending_staging_key: null,
                            chunk_size: 500,
                            work_budget_ms: 5000,
                            breathing_interval_ms: 5000,
                            rows_exported: 0,
                            bytes_written: 16,
                            callback_url: null,
                            callback_status: null,
                            error: null,
                            created_at: '2024-01-01T17:00:00.000Z',
                            updated_at: '2024-01-01T17:00:00.000Z',
                            completed_at: null,
                        },
                    ] as any
                }
                if (opts.sql.includes('SELECT id FROM tmp_dump_jobs')) {
                    return [] as any
                }
                if (opts.sql.includes('SELECT sql FROM sqlite_master')) {
                    return [{ sql: 'CREATE TABLE users (id INTEGER)' }] as any
                }
                if (opts.sql.includes('SELECT * FROM "users"')) {
                    return [{ id: 1 }, { id: 2 }] as any
                }
                if (opts.sql.startsWith('UPDATE tmp_dump_jobs')) {
                    updatedStatus = String(opts.params?.[0] ?? '')
                    return [] as any
                }
                if (opts.sql.includes('FROM tmp_cron_tasks')) {
                    return [] as any
                }
                return [] as any
            }
        )

        await doInstance.alarm()

        expect(updatedStatus).toBe('completed')
        expect(completedParts.length).toBe(1)
    })

    it('should preserve bidirectional coexistence between active dump breathing alarms and CronPlugin alarms', async () => {
        const physicalAlarms: number[] = []
        const stateWithAlarm = {
            storage: {
                ...mockStorage,
                setAlarm: vi.fn(async (ts: number) => {
                    physicalAlarms.push(ts)
                }),
                getAlarm: vi.fn(async () =>
                    physicalAlarms.length
                        ? physicalAlarms[physicalAlarms.length - 1]
                        : null
                ),
                deleteAlarm: vi.fn(async () => {
                    physicalAlarms.length = 0
                }),
            },
            getTags: vi.fn().mockReturnValue([]),
        } as any

        const mockBucket = {
            resumeMultipartUpload: vi.fn(() => ({
                uploadPart: vi.fn(async (partNumber: number) => ({
                    partNumber,
                    etag: `e-${partNumber}`,
                })),
                complete: vi.fn(async () => ({
                    key: 'dump_20240101-170000.sql',
                })),
                abort: vi.fn(),
            })),
            get: vi.fn(),
            put: vi.fn(),
            delete: vi.fn(),
        } as unknown as R2Bucket

        const doInstance = new StarbaseDBDurableObject(stateWithAlarm, {
            CLIENT_AUTHORIZATION_TOKEN: 'client-token',
            DUMP_BUCKET: mockBucket,
        } as any)

        // Stateful in-memory slot + job + cron backing
        const alarmSlots = new Map<string, number>()
        let dumpJob: any = {
            id: 'job-coexist-1',
            status: 'in_progress',
            r2_key: 'dump_20240101-170000.sql',
            upload_id: 'u-coexist',
            tables_json: JSON.stringify(['users']),
            table_index: 0,
            row_offset: 0,
            schema_emitted: 0,
            parts_json: '[]',
            pending_buffer: btoa('SQLite format 3\0'),
            pending_staging_key: null,
            chunk_size: 500,
            work_budget_ms: 5000,
            breathing_interval_ms: 5000,
            rows_exported: 0,
            bytes_written: 16,
            callback_url: null,
            callback_status: null,
            error: null,
            created_at: '2024-01-01T17:00:00.000Z',
            updated_at: '2024-01-01T17:00:00.000Z',
            completed_at: null,
        }
        const cronTasks = [
            {
                name: 'nightly_sync',
                cron_tab: '0 * * * *',
                payload: '{}',
                callback_host: 'https://starbase.workers.dev',
                is_active: 1,
            },
        ]

        vi.spyOn(doInstance, 'executeQuery').mockImplementation(
            async (opts: { sql: string; params?: unknown[] }) => {
                const sql = opts.sql.replace(/\s+/g, ' ').trim()
                if (
                    sql.includes(
                        'SELECT slot, scheduled_at FROM tmp_alarm_slots'
                    )
                ) {
                    return Array.from(alarmSlots.entries()).map(
                        ([slot, scheduled_at]) => ({ slot, scheduled_at })
                    ) as any
                }
                if (sql.startsWith('INSERT OR REPLACE INTO tmp_alarm_slots')) {
                    alarmSlots.set(
                        String(opts.params?.[0]),
                        Number(opts.params?.[1])
                    )
                    return [] as any
                }
                if (sql.startsWith('DELETE FROM tmp_alarm_slots')) {
                    alarmSlots.delete(String(opts.params?.[0]))
                    return [] as any
                }
                if (
                    sql.includes('SELECT * FROM tmp_dump_jobs') &&
                    sql.includes("status IN ('pending', 'in_progress')")
                ) {
                    return dumpJob.status === 'in_progress'
                        ? [{ ...dumpJob }]
                        : ([] as any)
                }
                if (sql.includes('SELECT id FROM tmp_dump_jobs')) {
                    return dumpJob.status === 'in_progress'
                        ? [{ id: dumpJob.id }]
                        : ([] as any)
                }
                if (sql.includes('SELECT sql FROM sqlite_master')) {
                    return [{ sql: 'CREATE TABLE users (id INTEGER)' }] as any
                }
                if (sql.includes('SELECT * FROM "users"')) {
                    return [{ id: 1 }] as any
                }
                if (sql.startsWith('UPDATE tmp_dump_jobs')) {
                    dumpJob = {
                        ...dumpJob,
                        status: String(opts.params?.[0]),
                    }
                    return [] as any
                }
                if (sql.includes('FROM tmp_cron_tasks')) {
                    return cronTasks as any
                }
                return [] as any
            }
        )

        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValue(new Response('ok', { status: 200 }))

        const baseNow = Date.now()
        const dumpAt = baseNow + 5_000
        const cronAt = baseNow + 300_000

        // Direction 1: Dump schedules 5s breathing alarm, then CronPlugin middleware runs setAlarm(+300s).
        // Physical DO alarm MUST stay at the earlier +5s dump time (never clobbered by +300s cron!).
        await doInstance.scheduleDumpAlarm(dumpAt)
        await doInstance.setAlarm(cronAt)
        expect(physicalAlarms[physicalAlarms.length - 1]).toBe(dumpAt)
        expect(alarmSlots.get('dump')).toBe(dumpAt)
        expect(alarmSlots.get('cron')).toBe(cronAt)

        // Direction 2: Dump alarm fires now while cron is still 300s in the future.
        // Dump MUST complete, /cron/callback MUST NOT fire prematurely, and physical alarm MUST re-arm to cronAt!
        alarmSlots.set('dump', Date.now() - 10) // Dump slot is now due
        await doInstance.alarm()

        expect(dumpJob.status).toBe('completed')
        expect(fetchSpy).not.toHaveBeenCalled()
        expect(alarmSlots.has('dump')).toBe(false)
        expect(alarmSlots.get('cron')).toBe(cronAt)
        expect(physicalAlarms[physicalAlarms.length - 1]).toBe(cronAt)

        // Direction 3: Later when cronAt becomes due, /cron/callback fires normally.
        alarmSlots.set('cron', Date.now() - 10)
        await doInstance.alarm()

        expect(fetchSpy).toHaveBeenCalledTimes(1)
        expect(String(fetchSpy.mock.calls[0][0])).toBe(
            'https://starbase.workers.dev/cron/callback'
        )
        fetchSpy.mockRestore()
    })
})
