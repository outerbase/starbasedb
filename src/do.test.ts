import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { StarbaseDBDurableObject } from './do'

vi.mock('cloudflare:workers', () => {
    return {
        DurableObject: class MockDurableObject {
            ctx: DurableObjectState
            env: Env

            constructor(ctx: DurableObjectState, env: Env) {
                this.ctx = ctx
                this.env = env
            }
        },
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

const createMockCursor = () => ({
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
})

const mockStorage = {
    sql: {
        databaseSize: 4096,
        exec: vi.fn(() => createMockCursor()),
    },
    getAlarm: vi.fn(),
    setAlarm: vi.fn(),
    deleteAlarm: vi.fn(),
}

const mockDurableObjectState = {
    storage: mockStorage,
    getTags: vi.fn().mockReturnValue(['session-123']),
} as any

const mockEnv = { CLIENT_AUTHORIZATION_TOKEN: 'client-token' } as any

let instance: StarbaseDBDurableObject

beforeEach(() => {
    mockStorage.sql.exec.mockImplementation(() => createMockCursor())
    mockStorage.getAlarm.mockResolvedValue(null)
    mockStorage.setAlarm.mockResolvedValue(undefined)
    mockStorage.deleteAlarm.mockResolvedValue(undefined)
    mockDurableObjectState.getTags.mockReturnValue(['session-123'])

    instance = new StarbaseDBDurableObject(mockDurableObjectState, mockEnv)

    mockStorage.sql.exec.mockClear()
    mockStorage.getAlarm.mockClear()
    mockStorage.setAlarm.mockClear()
    mockStorage.deleteAlarm.mockClear()
    mockDurableObjectState.getTags.mockClear()
})

afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
})

describe('StarbaseDBDurableObject Tests', () => {
    it('should initialize SQL storage', () => {
        expect(instance.sql).toBeDefined()
        expect(instance.storage).toBeDefined()
    })

    it('should install default temporary tables on construction', () => {
        new StarbaseDBDurableObject(mockDurableObjectState, mockEnv)

        const schemaStatements = mockStorage.sql.exec.mock.calls.map((call) =>
            String((call as unknown[])[0])
        )
        expect(schemaStatements).toHaveLength(4)
        expect(schemaStatements[0]).toContain('tmp_cache')
        expect(schemaStatements[1]).toContain('tmp_allowlist_queries')
        expect(schemaStatements[2]).toContain('tmp_allowlist_rejections')
        expect(schemaStatements[3]).toContain('tmp_rls_policies')
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

    it('should expose bound durable object helpers from init()', async () => {
        mockStorage.getAlarm.mockResolvedValueOnce(12345)

        const helpers = instance.init()
        const alarm = await helpers.getAlarm()
        await helpers.deleteAlarm()
        const queryResult = await helpers.executeQuery({
            sql: 'SELECT * FROM users',
        })

        expect(alarm).toBe(12345)
        expect(mockStorage.getAlarm).toHaveBeenCalled()
        expect(mockStorage.deleteAlarm).toHaveBeenCalled()
        expect(queryResult).toEqual([
            { id: 1, name: 'Alice' },
            { id: 2, name: 'Bob' },
        ])
    })

    it('should expose statistics from init()', async () => {
        const helpers = instance.init()
        vi.spyOn(instance, 'executeQuery').mockResolvedValueOnce([
            { count: 7 },
        ] as any)
        instance.connections.set(
            'active-session',
            new global.WebSocket('ws://localhost') as any
        )

        const statistics = await helpers.getStatistics()

        expect(instance.executeQuery).toHaveBeenCalledWith(
            expect.objectContaining({
                sql: expect.stringContaining('tmp_query_log'),
                isRaw: false,
            })
        )
        expect(statistics).toEqual({
            databaseSize: 4096,
            activeConnections: 1,
            recentQueries: 7,
        })
    })

    it('should clamp scheduled alarms to at least one second in the future', async () => {
        vi.useFakeTimers()
        vi.setSystemTime(new Date('2026-05-12T12:00:00Z'))

        await instance.setAlarm(Date.now() + 100, {
            allowConcurrency: true,
        } as any)

        expect(mockStorage.setAlarm).toHaveBeenCalledWith(Date.now() + 1000, {
            allowConcurrency: true,
        })
    })

    it('should log and rethrow alarm scheduling failures', async () => {
        const consoleErrorSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})
        const failure = new Error('storage failed')
        mockStorage.setAlarm.mockRejectedValueOnce(failure)

        await expect(instance.setAlarm(Date.now() + 1000)).rejects.toThrow(
            'storage failed'
        )
        expect(consoleErrorSpy).toHaveBeenCalledWith(
            'Error setting alarm: ',
            failure
        )
    })

    it('should return a raw query response with metadata when requested', async () => {
        const result = await instance.executeQuery({
            sql: 'SELECT * FROM users WHERE id = ?',
            params: [1],
            isRaw: true,
        })

        expect(mockStorage.sql.exec).toHaveBeenCalledWith(
            'SELECT * FROM users WHERE id = ?',
            1
        )
        expect(result).toEqual({
            columns: ['id', 'name'],
            rows: [
                [1, 'Alice'],
                [2, 'Bob'],
            ],
            meta: {
                rows_read: 2,
                rows_written: 1,
            },
        })
    })

    it('should rethrow transaction errors after logging them', async () => {
        const consoleErrorSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})
        const failure = new Error('second query failed')

        vi.spyOn(instance, 'executeQuery')
            .mockResolvedValueOnce([{ ok: true }] as any)
            .mockRejectedValueOnce(failure)

        await expect(
            instance.executeTransaction(
                [{ sql: 'SELECT 1' }, { sql: 'SELECT broken' }],
                false
            )
        ).rejects.toThrow('second query failed')

        expect(consoleErrorSpy).toHaveBeenCalledWith(
            'Transaction Execution Error:',
            failure
        )
    })

    it('should reject socket requests that are missing a websocket upgrade', async () => {
        const response = await instance.fetch(
            new Request('https://example.com/socket')
        )

        expect(response.status).toBe(400)
    })

    it('should create websocket sessions through the fetch upgrade path', async () => {
        const response = await instance.fetch(
            new Request('https://example.com/socket?sessionId=session-abc', {
                headers: { upgrade: 'websocket' },
            })
        )

        expect(response.status).toBe(101)
        expect(instance.connections.has('session-abc')).toBe(true)
    })

    it('should dispatch websocket message handlers and clean up errored sockets', async () => {
        const consoleErrorSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})
        const response = await instance.clientConnected('session-error')
        const server = instance.connections.get('session-error') as any
        const messageHandler = server.addEventListener.mock.calls.find(
            ([event]: [string]) => event === 'message'
        )?.[1]
        const errorHandler = server.addEventListener.mock.calls.find(
            ([event]: [string]) => event === 'error'
        )?.[1]
        const webSocketMessageSpy = vi
            .spyOn(instance, 'webSocketMessage')
            .mockResolvedValueOnce(undefined)
        const failure = new Error('closed')

        await messageHandler({ data: '{"action":"query"}' })
        errorHandler(failure)

        expect(response.status).toBe(101)
        expect(webSocketMessageSpy).toHaveBeenCalledWith(
            server,
            '{"action":"query"}'
        )
        expect(consoleErrorSpy).toHaveBeenCalledWith(
            'WebSocket error for session-error:',
            failure
        )
        expect(instance.connections.has('session-error')).toBe(false)
    })

    it('should broadcast messages only to the requested session', async () => {
        const target = new global.WebSocket('ws://localhost') as any
        const other = new global.WebSocket('ws://localhost') as any
        instance.connections.set('target-session', target)
        instance.connections.set('other-session', other)

        const response = await instance.fetch(
            new Request(
                'https://example.com/socket/broadcast?sessionId=target-session',
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ event: 'refresh' }),
                }
            )
        )

        expect(response.status).toBe(200)
        expect(target.send).toHaveBeenCalledWith(
            JSON.stringify({ event: 'refresh' })
        )
        expect(other.send).not.toHaveBeenCalled()
    })

    it('should remove failed websocket connections during broadcast', async () => {
        const failedSocket = new global.WebSocket('ws://localhost') as any
        failedSocket.send = vi.fn(() => {
            throw new Error('closed')
        })
        instance.connections.set('dead-session', failedSocket)

        await instance.fetch(
            new Request('https://example.com/socket/broadcast', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ event: 'refresh' }),
            })
        )

        expect(instance.connections.has('dead-session')).toBe(false)
    })

    it('should execute websocket query messages and send the results', async () => {
        const ws = new global.WebSocket('ws://localhost') as any
        vi.spyOn(instance, 'executeTransaction').mockResolvedValueOnce([
            [{ id: 1 }],
        ])

        await instance.webSocketMessage(
            ws,
            JSON.stringify({
                action: 'query',
                sql: 'SELECT * FROM users WHERE id = ?',
                params: [1],
            })
        )

        expect(instance.executeTransaction).toHaveBeenCalledWith(
            [{ sql: 'SELECT * FROM users WHERE id = ?', params: [1] }],
            false
        )
        expect(ws.send).toHaveBeenCalledWith(JSON.stringify([[{ id: 1 }]]))
    })

    it('should close websocket connections and remove tagged sessions', async () => {
        const ws = new global.WebSocket('ws://localhost') as any
        instance.connections.set('session-123', ws)

        await instance.webSocketClose(ws, 1000, 'done', true)

        expect(ws.close).toHaveBeenCalledWith(
            1000,
            'StarbaseDB is closing WebSocket connection'
        )
        expect(instance.connections.has('session-123')).toBe(false)
    })

    it('should skip cron callbacks when no active tasks exist', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch')
        vi.spyOn(instance, 'executeQuery').mockResolvedValueOnce([])

        await instance.alarm()

        expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('should invoke cron callbacks with client auth when active tasks exist', async () => {
        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(new Response(null, { status: 200 }) as any)
        vi.spyOn(instance, 'executeQuery').mockResolvedValueOnce([
            { callback_host: 'https://cron.example.com' },
        ] as any)

        await instance.alarm()

        expect(fetchSpy).toHaveBeenCalledWith(
            'https://cron.example.com/cron/callback',
            expect.objectContaining({
                method: 'POST',
                headers: {
                    Authorization: 'Bearer client-token',
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify([
                    { callback_host: 'https://cron.example.com' },
                ]),
            })
        )
    })

    it('should reschedule cron alarms when callbacks fail', async () => {
        const consoleErrorSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})
        vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(
            new Error('network failed')
        )
        vi.spyOn(instance, 'executeQuery').mockResolvedValueOnce([
            { callback_host: 'https://cron.example.com' },
        ] as any)
        const setAlarmSpy = vi
            .spyOn(instance, 'setAlarm')
            .mockResolvedValueOnce(undefined)

        await instance.alarm()

        expect(consoleErrorSpy).toHaveBeenCalledWith(
            'Failed to call the alarm/cron callback:',
            expect.any(Error)
        )
        expect(setAlarmSpy).toHaveBeenCalledWith(expect.any(Number))
    })

    it('should log recovery alarm failures after callback errors', async () => {
        const consoleErrorSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})
        const retryFailure = new Error('retry failed')
        vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(
            new Error('network failed')
        )
        vi.spyOn(instance, 'executeQuery').mockResolvedValueOnce([
            { callback_host: 'https://cron.example.com' },
        ] as any)
        vi.spyOn(instance, 'setAlarm').mockRejectedValueOnce(retryFailure)

        await instance.alarm()

        expect(consoleErrorSpy).toHaveBeenCalledWith(
            'Failed to set recovery alarm:',
            retryFailure
        )
    })

    it('should reschedule alarms when task lookup fails', async () => {
        const consoleErrorSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})
        const failure = new Error('query failed')
        vi.spyOn(instance, 'executeQuery').mockRejectedValueOnce(failure)
        const setAlarmSpy = vi
            .spyOn(instance, 'setAlarm')
            .mockResolvedValueOnce(undefined)

        await instance.alarm()

        expect(consoleErrorSpy).toHaveBeenCalledWith(
            'There was an error processing an alarm: ',
            failure
        )
        expect(setAlarmSpy).toHaveBeenCalledWith(expect.any(Number))
    })

    it('should log recovery alarm failures when task lookup fails', async () => {
        const consoleErrorSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})
        const failure = new Error('query failed')
        const retryFailure = new Error('retry failed')
        vi.spyOn(instance, 'executeQuery').mockRejectedValueOnce(failure)
        vi.spyOn(instance, 'setAlarm').mockRejectedValueOnce(retryFailure)

        await instance.alarm()

        expect(consoleErrorSpy).toHaveBeenCalledWith(
            'There was an error processing an alarm: ',
            failure
        )
        expect(consoleErrorSpy).toHaveBeenCalledWith(
            'Failed to set recovery alarm:',
            retryFailure
        )
    })

    it('should handle errors in executeQuery', async () => {
        const consoleErrorSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})

        const failure = new Error('Query failed')

        mockStorage.sql.exec.mockImplementationOnce(() => {
            throw failure
        })

        await expect(
            instance.executeQuery({ sql: 'INVALID QUERY' })
        ).rejects.toThrow('Query failed')
        expect(consoleErrorSpy).toHaveBeenCalledWith(
            'SQL Execution Error:',
            failure
        )
    })
})
