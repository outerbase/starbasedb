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

    it('should fail missing-bucket dump job via shared path (sending webhook) and still schedule next queued job', async () => {
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
        const jobs = new Map<string, any>([
            [
                'job-no-r2-1',
                {
                    id: 'job-no-r2-1',
                    status: 'in_progress',
                    r2_key: 'dump_1.sql',
                    upload_id: null,
                    tables_json: '[]',
                    table_index: 0,
                    row_offset: 0,
                    last_rowid: null,
                    parts_json: '[]',
                    pending_staging_key: null,
                    chunk_size: 500,
                    work_budget_ms: 5000,
                    breathing_interval_ms: 5000,
                    rows_exported: 0,
                    bytes_written: 0,
                    callback_url: 'https://hooks.example.com/fail',
                    callback_status: null,
                    error: null,
                    created_at: '2024-01-01T17:00:00.000Z',
                    updated_at: '2024-01-01T17:00:00.000Z',
                    completed_at: null,
                },
            ],
            [
                'job-no-r2-2',
                {
                    id: 'job-no-r2-2',
                    status: 'in_progress',
                    r2_key: 'dump_2.sql',
                    upload_id: null,
                    tables_json: '[]',
                    table_index: 0,
                    row_offset: 0,
                    last_rowid: null,
                    parts_json: '[]',
                    pending_staging_key: null,
                    chunk_size: 500,
                    work_budget_ms: 5000,
                    breathing_interval_ms: 5000,
                    rows_exported: 0,
                    bytes_written: 0,
                    callback_url: null,
                    callback_status: null,
                    error: null,
                    created_at: '2024-01-01T17:00:01.000Z',
                    updated_at: '2024-01-01T17:00:01.000Z',
                    completed_at: null,
                },
            ],
        ])
        const slots = new Map<string, number>()

        vi.spyOn(doInstance, 'executeQuery').mockImplementation(
            async (opts: { sql: string; params?: unknown[] }) => {
                const sql = opts.sql.replace(/\s+/g, ' ').trim()
                if (sql.includes('FROM tmp_alarm_slots')) {
                    return Array.from(slots.entries()).map(
                        ([slot, scheduled_at]) => ({ slot, scheduled_at })
                    ) as any
                }
                if (sql.startsWith('INSERT OR REPLACE INTO tmp_alarm_slots')) {
                    slots.set(
                        String(opts.params?.[0]),
                        Number(opts.params?.[1])
                    )
                    return [] as any
                }
                if (sql.startsWith('DELETE FROM tmp_alarm_slots')) {
                    slots.delete(String(opts.params?.[0]))
                    return [] as any
                }
                if (sql.includes('SELECT * FROM tmp_dump_jobs')) {
                    const active = Array.from(jobs.values()).filter(
                        (j) => j.status === 'in_progress'
                    )
                    return active.slice(0, 1) as any
                }
                if (sql.includes('SELECT id FROM tmp_dump_jobs')) {
                    const active = Array.from(jobs.values()).filter(
                        (j) => j.status === 'in_progress'
                    )
                    return active.slice(0, 1).map((j) => ({ id: j.id })) as any
                }
                if (sql.startsWith('INSERT OR REPLACE INTO tmp_dump_jobs')) {
                    const cols = sql
                        .match(/\(([^)]+)\)/)![1]
                        .split(',')
                        .map((c) => c.trim())
                    const rec: Record<string, any> = {}
                    cols.forEach((c, i) => (rec[c] = opts.params?.[i] ?? null))
                    jobs.set(String(rec.id), rec)
                    return [] as any
                }
                if (sql.includes('FROM tmp_cron_tasks')) {
                    throw new Error('no such table: tmp_cron_tasks')
                }
                return [] as any
            }
        )

        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValue(new Response('ok', { status: 200 }))

        await doInstance.alarm()

        expect(jobs.get('job-no-r2-1').status).toBe('failed')
        expect(jobs.get('job-no-r2-1').callback_status).toBe('delivered')
        expect(fetchSpy).toHaveBeenCalledTimes(1)
        // Second queued job MUST get a follow-up wake-up alarm
        expect(slots.has('dump')).toBe(true)
        expect(setAlarmMock).toHaveBeenCalled()
        fetchSpy.mockRestore()
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
            get: vi.fn(async () => ({
                arrayBuffer: async () =>
                    new TextEncoder().encode('SQLite format 3\0').buffer,
            })),
            put: vi.fn(),
            delete: vi.fn(async () => {}),
        } as unknown as R2Bucket

        const doInstance = new StarbaseDBDurableObject(stateWithAlarm, {
            DUMP_BUCKET: mockBucket,
        } as any)

        let updatedStatus = ''
        vi.spyOn(doInstance, 'executeQuery').mockImplementation(
            async (opts: { sql: string; params?: unknown[] }) => {
                if (opts.sql.includes('SELECT * FROM tmp_dump_jobs')) {
                    return [
                        {
                            id: 'job-alarm-1',
                            status: 'in_progress',
                            r2_key: 'dump_20240101-170000.sql',
                            upload_id: 'u-1',
                            tables_json: JSON.stringify(['users']),
                            table_index: 0,
                            row_offset: 0,
                            last_rowid: null,
                            parts_json: '[]',
                            pending_staging_key:
                                'dump_20240101-170000.sql.pending.16',
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
                if (opts.sql.includes('FROM "users"')) {
                    return [
                        { __sb_rid: 1, id: 1 },
                        { __sb_rid: 2, id: 2 },
                    ] as any
                }
                if (
                    opts.sql.startsWith('INSERT OR REPLACE INTO tmp_dump_jobs')
                ) {
                    updatedStatus = String(opts.params?.[1] ?? '')
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

    it('should preserve bidirectional alarm coexistence without starvation, early cron fire, or redundant SQL writes', async () => {
        let physicalAlarm: number | null = null
        const setAlarmSpy = vi.fn(async (ts: number) => {
            physicalAlarm = ts
        })
        const deleteAlarmSpy = vi.fn(async () => {
            physicalAlarm = null
        })
        const stateWithAlarm = {
            storage: {
                ...mockStorage,
                setAlarm: setAlarmSpy,
                getAlarm: vi.fn(async () => physicalAlarm),
                deleteAlarm: deleteAlarmSpy,
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
            get: vi.fn(async () => ({
                arrayBuffer: async () =>
                    new TextEncoder().encode('SQLite format 3\0').buffer,
            })),
            put: vi.fn(),
            delete: vi.fn(async () => {}),
        } as unknown as R2Bucket

        const doInstance = new StarbaseDBDurableObject(stateWithAlarm, {
            CLIENT_AUTHORIZATION_TOKEN: 'client-token',
            DUMP_BUCKET: mockBucket,
        } as any)

        const alarmSlots = new Map<string, number>()
        let slotWriteCount = 0
        let dumpJob: any = {
            id: 'job-coexist-1',
            status: 'in_progress',
            r2_key: 'dump_20240101-170000.sql',
            upload_id: 'u-coexist',
            tables_json: JSON.stringify(['users']),
            table_index: 0,
            row_offset: 0,
            last_rowid: null,
            parts_json: '[]',
            pending_staging_key: 'dump_20240101-170000.sql.pending.16',
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
                    slotWriteCount++
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
                if (sql.includes('SELECT * FROM tmp_dump_jobs')) {
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
                if (sql.includes('FROM "users"')) {
                    return [{ __sb_rid: 1, id: 1 }] as any
                }
                if (sql.startsWith('INSERT OR REPLACE INTO tmp_dump_jobs')) {
                    dumpJob = {
                        ...dumpJob,
                        status: String(opts.params?.[1]),
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

        const realNow = Date.now
        let fakeNow = 100_000
        Date.now = () => fakeNow

        try {
            // 1. Earliest dump slot is preserved even if a slower dump schedules +30s later
            await doInstance.scheduleDumpAlarm(fakeNow + 5_000) // 105_000
            await doInstance.scheduleDumpAlarm(fakeNow + 30_000)
            expect(alarmSlots.get('dump')).toBe(105_000)
            expect(physicalAlarm).toBe(105_000)

            // 2. Repeated CronPlugin middleware setAlarm(105_400) does not clobber 105_000 AND skips no-op SQL write
            const writesBefore = slotWriteCount
            await doInstance.setAlarm(fakeNow + 5_400) // 105_400
            await doInstance.setAlarm(fakeNow + 5_400) // identical -> no-op write!
            expect(slotWriteCount - writesBefore).toBe(1)
            expect(physicalAlarm).toBe(105_000)

            // 3. Sustained <1s traffic past due time MUST NOT slide physicalAlarm forward (no starvation!)
            fakeNow = 104_400
            await doInstance.setAlarm(105_400)
            fakeNow = 105_000
            await doInstance.setAlarm(165_000)
            expect(physicalAlarm).toBe(105_000)

            // Reset cron to 105_400 (only 400ms after dump at 105_000) and fire dump alarm at 105_000
            alarmSlots.set('cron', 105_400)
            physicalAlarm = null
            await doInstance.alarm()

            // Dump completed; cron at 105_400 MUST NOT fire early at 105_000; physical alarm re-armed to 105_400!
            expect(dumpJob.status).toBe('completed')
            expect(fetchSpy).not.toHaveBeenCalled()
            expect(alarmSlots.has('dump')).toBe(false)
            expect(alarmSlots.get('cron')).toBe(105_400)
            expect(physicalAlarm).toBe(105_400)

            // 4. Advance clock to 105_400 -> cron now fires normally
            fakeNow = 105_400
            physicalAlarm = null
            await doInstance.alarm()
            expect(fetchSpy).toHaveBeenCalledTimes(1)
            expect(String(fetchSpy.mock.calls[0][0])).toBe(
                'https://starbase.workers.dev/cron/callback'
            )

            // 4b. Final-second CronPlugin middleware call (now=109_500, target=110_000) MUST NOT shift
            // logical slots.cron forward to 110_500 (otherwise firing at 110_000 would miss cron!).
            fakeNow = 106_000
            await doInstance.setAlarm(110_000)
            expect(alarmSlots.get('cron')).toBe(110_000)
            expect(physicalAlarm).toBe(110_000)
            fakeNow = 109_500
            await doInstance.setAlarm(110_000)
            expect(alarmSlots.get('cron')).toBe(110_000)
            expect(physicalAlarm).toBe(110_000)
            fakeNow = 110_000
            physicalAlarm = null
            await doInstance.alarm()
            expect(fetchSpy).toHaveBeenCalledTimes(2)

            // 5. deleteAlarm clears cron slot while preserving an active dump slot, and deletes physical alarm if none left
            await doInstance.scheduleDumpAlarm(fakeNow + 5_000)
            await doInstance.setAlarm(fakeNow + 60_000)
            await doInstance.deleteAlarm()
            expect(alarmSlots.has('cron')).toBe(false)
            expect(alarmSlots.get('dump')).toBe(fakeNow + 5_000)
            expect(physicalAlarm).toBe(fakeNow + 5_000)

            // Stale dump slot with no active job is cleared cleanly
            fakeNow += 5_000
            physicalAlarm = null
            await doInstance.alarm()
            expect(alarmSlots.has('dump')).toBe(false)

            await doInstance.deleteAlarm()
            expect(deleteAlarmSpy).toHaveBeenCalledTimes(1)
        } finally {
            Date.now = realNow
            fetchSpy.mockRestore()
        }
    })
})
