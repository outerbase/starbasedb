import { describe, expect, it, vi, beforeEach } from 'vitest'
import { StarbaseDBDurableObject } from './do'

vi.mock('cloudflare:workers', () => {
    return {
        DurableObject: class MockDurableObject {
            ctx: any
            env: any
            constructor(ctx: any, env: any) {
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
    text() {
        return Promise.resolve(String(this.body ?? ''))
    }
    json() {
        return Promise.resolve(
            typeof this.body === 'string' ? JSON.parse(this.body) : this.body
        )
    }
}

const mockStorage = {
    sql: {
        databaseSize: 16384,
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
    getAlarm: vi.fn().mockResolvedValue(1700000000),
    setAlarm: vi.fn().mockResolvedValue(undefined),
    deleteAlarm: vi.fn().mockResolvedValue(undefined),
}

const mockDurableObjectState = {
    storage: mockStorage,
    getTags: vi.fn().mockReturnValue(['session-123']),
} as any

const mockEnv = {
    CLIENT_AUTHORIZATION_TOKEN: 'test-auth-token-xyz',
} as any

let instance: StarbaseDBDurableObject

beforeEach(() => {
    mockStorage.sql.exec.mockReturnValue({
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

    instance = new StarbaseDBDurableObject(mockDurableObjectState, mockEnv)
    vi.clearAllMocks()
})

describe('StarbaseDBDurableObject Tests', () => {
    it('should initialize SQL storage and install tmp tables', () => {
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

    it('should execute a query with parameters and raw formatting', async () => {
        const sql = 'SELECT * FROM users WHERE id = ?'
        const result: any = await instance.executeQuery({
            sql,
            params: [1],
            isRaw: true,
        })

        expect(mockStorage.sql.exec).toHaveBeenCalledWith(sql, 1)
        expect(result.columns).toEqual(['id', 'name'])
        expect(result.rows).toEqual([
            [1, 'Alice'],
            [2, 'Bob'],
        ])
        expect(result.meta.rows_read).toBe(2)
        expect(result.meta.rows_written).toBe(1)
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

    it('should handle WebSocket connections and generate UUID if sessionId not provided', async () => {
        const response = await instance.clientConnected()

        expect(response.status).toBe(101)
        expect(instance.connections.size).toBe(1)
    })

    it('should return 400 for unknown fetch requests', async () => {
        const request = new Request('https://example.com/unknown')
        const response = await instance.fetch(request)

        expect(response.status).toBe(400)
    })

    it('should handle errors in executeQuery', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})

        mockStorage.sql.exec.mockImplementationOnce(() => {
            throw new Error('Query failed')
        })

        await expect(
            instance.executeQuery({ sql: 'INVALID QUERY' })
        ).rejects.toThrow('Query failed')
    })

    describe('Alarms API & Processing', () => {
        it('should get, set and delete alarms via storage', async () => {
            const alarmTime = await instance.getAlarm()
            expect(alarmTime).toBe(1700000000)
            expect(mockStorage.getAlarm).toHaveBeenCalled()

            const futureTime = Date.now() + 100000
            await instance.setAlarm(futureTime)
            expect(mockStorage.setAlarm).toHaveBeenCalledWith(
                futureTime,
                undefined
            )

            await instance.deleteAlarm()
            expect(mockStorage.deleteAlarm).toHaveBeenCalled()
        })

        it('should exit alarm early if no active tmp_cron_tasks exist', async () => {
            mockStorage.sql.exec.mockReturnValueOnce({
                toArray: vi.fn().mockReturnValue([]),
            })

            const globalFetch = vi.fn()
            global.fetch = globalFetch

            await instance.alarm()

            expect(globalFetch).not.toHaveBeenCalled()
        })

        it('should dispatch cron webhook and handle successful execution', async () => {
            mockStorage.sql.exec.mockReturnValueOnce({
                toArray: vi.fn().mockReturnValue([
                    {
                        id: 1,
                        callback_host: 'https://example.com',
                        is_active: 1,
                    },
                ]),
            })

            const globalFetch = vi.fn().mockResolvedValue(new Response('ok'))
            global.fetch = globalFetch

            await instance.alarm()

            expect(globalFetch).toHaveBeenCalledWith(
                'https://example.com/cron/callback',
                expect.objectContaining({
                    method: 'POST',
                    headers: expect.objectContaining({
                        Authorization: 'Bearer test-auth-token-xyz',
                    }),
                })
            )
        })

        it('should reschedule recovery alarm if cron callback fetch fails', async () => {
            vi.spyOn(console, 'error').mockImplementation(() => {})

            mockStorage.sql.exec.mockReturnValueOnce({
                toArray: vi.fn().mockReturnValue([
                    {
                        id: 1,
                        callback_host: 'https://example.com',
                        is_active: 1,
                    },
                ]),
            })

            global.fetch = vi.fn().mockRejectedValue(new Error('Network error'))

            await instance.alarm()

            expect(mockStorage.setAlarm).toHaveBeenCalledWith(
                expect.any(Number),
                undefined
            )
        })
    })

    describe('getStatistics()', () => {
        it('should compute database statistics from sql storage and query log', async () => {
            mockStorage.sql.exec.mockReturnValueOnce({
                toArray: vi.fn().mockReturnValue([{ count: 42 }]),
            })

            const stats = await instance.getStatistics()

            expect(stats.databaseSize).toBe(16384)
            expect(stats.activeConnections).toBe(0)
            expect(stats.recentQueries).toBe(42)
        })

        it('should return recentQueries as 0 if tmp_query_log is empty', async () => {
            mockStorage.sql.exec.mockReturnValueOnce({
                toArray: vi.fn().mockReturnValue([]),
            })

            const stats = await instance.getStatistics()
            expect(stats.recentQueries).toBe(0)
        })
    })

    describe('WebSocket messaging & closing', () => {
        it('should process webSocketMessage with query action', async () => {
            const mockWs = { send: vi.fn() } as any

            await instance.webSocketMessage(
                mockWs,
                JSON.stringify({
                    action: 'query',
                    sql: 'SELECT 1',
                    params: [],
                })
            )

            expect(mockWs.send).toHaveBeenCalled()
        })

        it('should close WebSocket and remove tag from connections map', async () => {
            const mockWs = { close: vi.fn() } as any
            instance.connections.set('session-123', mockWs)

            await instance.webSocketClose(mockWs, 1000, 'Normal Closure', true)

            expect(mockWs.close).toHaveBeenCalledWith(
                1000,
                'StarbaseDB is closing WebSocket connection'
            )
            expect(instance.connections.has('session-123')).toBe(false)
        })
    })

    describe('fetch() routing', () => {
        it('should return 400 for /socket when upgrade header is missing', async () => {
            const req = new Request('https://example.com/socket')
            const res = await instance.fetch(req)
            expect(res.status).toBe(400)
            expect(await res.text()).toBe('Expected WebSocket')
        })

        it('should upgrade /socket when upgrade header is websocket', async () => {
            const req = new Request(
                'https://example.com/socket?sessionId=sess-1',
                {
                    headers: { upgrade: 'websocket' },
                }
            )
            const res = await instance.fetch(req)
            expect(res.status).toBe(101)
            expect(instance.connections.has('sess-1')).toBe(true)
        })

        it('should broadcast message to all connected clients', async () => {
            const ws1 = { send: vi.fn() } as any
            const ws2 = { send: vi.fn() } as any
            instance.connections.set('conn-1', ws1)
            instance.connections.set('conn-2', ws2)

            const req = new Request('https://example.com/socket/broadcast', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ event: 'ping' }),
            })

            const res = await instance.fetch(req)
            expect(res.status).toBe(200)
            expect(ws1.send).toHaveBeenCalledWith(
                JSON.stringify({ event: 'ping' })
            )
            expect(ws2.send).toHaveBeenCalledWith(
                JSON.stringify({ event: 'ping' })
            )
        })

        it('should broadcast message to specific sessionId only when provided', async () => {
            const ws1 = { send: vi.fn() } as any
            const ws2 = { send: vi.fn() } as any
            instance.connections.set('conn-1', ws1)
            instance.connections.set('conn-2', ws2)

            const req = new Request(
                'https://example.com/socket/broadcast?sessionId=conn-1',
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ event: 'direct' }),
                }
            )

            const res = await instance.fetch(req)
            expect(res.status).toBe(200)
            expect(ws1.send).toHaveBeenCalledWith(
                JSON.stringify({ event: 'direct' })
            )
            expect(ws2.send).not.toHaveBeenCalled()
        })
    })
})
