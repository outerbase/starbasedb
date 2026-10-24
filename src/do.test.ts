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
    addEventListener = vi.fn((event: string, handler: Function) => {
        ;(this as any)[`on_${event}`] = handler
    })
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
        databaseSize: 1024,
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
    getAlarm: vi.fn().mockResolvedValue(123456789),
    setAlarm: vi.fn().mockResolvedValue(undefined),
    deleteAlarm: vi.fn().mockResolvedValue(undefined),
}

const mockDurableObjectState = {
    storage: mockStorage,
    getTags: vi.fn().mockReturnValue(['session-123']),
} as any

const mockEnv = {
    CLIENT_AUTHORIZATION_TOKEN: 'mock-client-token',
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
    it('should initialize SQL storage', () => {
        expect(instance.sql).toBeDefined()
        expect(instance.storage).toBeDefined()
    })

    it('should expose init methods', () => {
        const methods = instance.init()
        expect(typeof methods.getAlarm).toBe('function')
        expect(typeof methods.setAlarm).toBe('function')
        expect(typeof methods.deleteAlarm).toBe('function')
        expect(typeof methods.getStatistics).toBe('function')
        expect(typeof methods.executeQuery).toBe('function')
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

    it('should execute a raw query and return formatted columns and rows', async () => {
        const sql = 'SELECT * FROM users'
        const result = await instance.executeQuery({
            sql,
            params: [1, 'test'],
            isRaw: true,
        })

        expect(mockStorage.sql.exec).toHaveBeenCalledWith(sql, 1, 'test')
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

    it('should execute a transaction and return results', async () => {
        const queries = [
            { sql: 'SELECT * FROM orders' },
            { sql: 'SELECT * FROM products' },
        ]
        const result = await instance.executeTransaction(queries, false)

        expect(mockStorage.sql.exec).toHaveBeenCalledTimes(2)
        expect(result.length).toBe(2)
    })

    it('should handle errors in executeTransaction', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        mockStorage.sql.exec.mockImplementationOnce(() => {
            throw new Error('Transaction query failed')
        })

        await expect(
            instance.executeTransaction([{ sql: 'BAD SQL' }], false)
        ).rejects.toThrow('Transaction query failed')
    })

    it('should get and set alarms correctly', async () => {
        const alarmTime = await instance.getAlarm()
        expect(alarmTime).toBe(123456789)

        await instance.setAlarm(Date.now() + 5000)
        expect(mockStorage.setAlarm).toHaveBeenCalled()

        await instance.setAlarm(new Date(Date.now() + 10000))
        expect(mockStorage.setAlarm).toHaveBeenCalled()

        await instance.deleteAlarm()
        expect(mockStorage.deleteAlarm).toHaveBeenCalled()
    })

    it('should handle errors when setting alarm', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        mockStorage.setAlarm.mockRejectedValueOnce(new Error('Alarm failure'))

        await expect(instance.setAlarm(Date.now() + 5000)).rejects.toThrow(
            'Alarm failure'
        )
    })

    it('should process alarm when tasks exist', async () => {
        const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce({
            ok: true,
        } as Response)

        mockStorage.sql.exec.mockReturnValueOnce({
            columnNames: ['callback_host', 'is_active'],
            toArray: () => [
                { callback_host: 'https://callback.com', is_active: 1 },
            ],
        })

        await instance.alarm()

        expect(fetchMock).toHaveBeenCalledWith(
            'https://callback.com/cron/callback',
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({
                    Authorization: 'Bearer mock-client-token',
                }),
            })
        )
    })

    it('should handle alarm callback failure and reschedule', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        vi.spyOn(global, 'fetch').mockRejectedValueOnce(
            new Error('Callback failed')
        )

        mockStorage.sql.exec.mockReturnValueOnce({
            columnNames: ['callback_host', 'is_active'],
            toArray: () => [
                { callback_host: 'https://callback.com', is_active: 1 },
            ],
        })

        await instance.alarm()
        expect(mockStorage.setAlarm).toHaveBeenCalled()
    })

    it('should return early from alarm when no tasks exist', async () => {
        const fetchMock = vi.spyOn(global, 'fetch')
        mockStorage.sql.exec.mockReturnValueOnce({
            columnNames: ['callback_host'],
            toArray: () => [],
        })

        await instance.alarm()
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('should get statistics', async () => {
        mockStorage.sql.exec.mockReturnValueOnce({
            toArray: () => [{ count: 42 }],
        })

        const stats = await instance.getStatistics()
        expect(stats.databaseSize).toBe(1024)
        expect(stats.recentQueries).toBe(42)
    })

    it('should handle WebSocket connections', async () => {
        const response = await instance.clientConnected('session-123')

        expect(response.status).toBe(101)
        expect(instance.connections.has('session-123')).toBe(true)
    })

    it('should handle WebSocket without explicit sessionId', async () => {
        const response = await instance.clientConnected()
        expect(response.status).toBe(101)
        expect(instance.connections.size).toBeGreaterThan(0)
    })

    it('should route /socket and /socket/broadcast in fetch', async () => {
        const wsReq = new Request('https://example.com/socket', {
            headers: { upgrade: 'websocket' },
        })
        const wsRes = await instance.fetch(wsReq)
        expect(wsRes.status).toBe(101)

        const badWsReq = new Request('https://example.com/socket')
        const badWsRes = await instance.fetch(badWsReq)
        expect(badWsRes.status).toBe(400)

        // Broadcast
        await instance.clientConnected('session-target')
        const broadcastReq = new Request(
            'https://example.com/socket/broadcast?sessionId=session-target',
            {
                method: 'POST',
                body: JSON.stringify({ type: 'EVENT', data: 123 }),
            }
        )
        const broadcastRes = await instance.fetch(broadcastReq)
        expect(broadcastRes.status).toBe(200)
    })

    it('should clean up dead connection on broadcast error', async () => {
        const mockWs = {
            send: vi.fn(() => {
                throw new Error('Dead connection')
            }),
        } as any
        instance.connections.set('dead-session', mockWs)

        const broadcastReq = new Request(
            'https://example.com/socket/broadcast',
            {
                method: 'POST',
                body: JSON.stringify({ type: 'ALL' }),
            }
        )
        await instance.fetch(broadcastReq)
        expect(instance.connections.has('dead-session')).toBe(false)
    })

    it('should handle webSocketMessage query action', async () => {
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

    it('should handle webSocketClose and remove connection by tag', async () => {
        const mockWs = { close: vi.fn() } as any
        instance.connections.set('session-123', mockWs)

        await instance.webSocketClose(mockWs, 1000, 'Normal closure', true)

        expect(mockWs.close).toHaveBeenCalledWith(
            1000,
            'StarbaseDB is closing WebSocket connection'
        )
        expect(instance.connections.has('session-123')).toBe(false)
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
})
