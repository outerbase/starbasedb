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
} as any

global.WebSocketPair = vi.fn(() => {
    const client = new global.WebSocket('ws://localhost')
    const server = new global.WebSocket('ws://localhost')
    server.accept = vi.fn()
    return { 0: client, 1: server }
}) as any

global.Response = class {
    body: any
    status: any
    webSocket: any
    constructor(body?: any, init?: any) {
        this.body = body
        this.status = init?.status ?? 200
        this.webSocket = init?.webSocket
    }
} as any

const mockStorage = {
    getAlarm: vi.fn().mockResolvedValue(123456),
    setAlarm: vi.fn().mockResolvedValue(undefined),
    deleteAlarm: vi.fn().mockResolvedValue(undefined),
    sql: {
        databaseSize: 4096,
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

const mockEnv = {
    CLIENT_AUTHORIZATION_TOKEN: 'client-token',
} as any

let instance: StarbaseDBDurableObject

beforeEach(() => {
    instance = new StarbaseDBDurableObject(mockDurableObjectState, mockEnv)
    vi.clearAllMocks()
})

describe('StarbaseDBDurableObject Tests', () => {
    it('should initialize SQL storage and expose RPC methods via init()', () => {
        expect(instance.sql).toBeDefined()
        expect(instance.storage).toBeDefined()

        const rpc = instance.init()
        expect(rpc.getAlarm).toBeTypeOf('function')
        expect(rpc.setAlarm).toBeTypeOf('function')
        expect(rpc.deleteAlarm).toBeTypeOf('function')
        expect(rpc.getStatistics).toBeTypeOf('function')
        expect(rpc.executeQuery).toBeTypeOf('function')
    })

    it('should get, set, and delete alarms including Date inputs and error handling', async () => {
        expect(await instance.getAlarm()).toBe(123456)

        const futureDate = new Date(Date.now() + 10000)
        await instance.setAlarm(futureDate)
        expect(mockStorage.setAlarm).toHaveBeenCalledWith(
            futureDate.getTime(),
            undefined
        )

        const pastTimestamp = Date.now() - 5000
        await instance.setAlarm(pastTimestamp)
        expect(mockStorage.setAlarm).toHaveBeenCalled()

        await instance.deleteAlarm()
        expect(mockStorage.deleteAlarm).toHaveBeenCalled()

        const consoleErrorSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})
        mockStorage.setAlarm.mockRejectedValueOnce(new Error('Alarm error'))
        await expect(instance.setAlarm(Date.now() + 5000)).rejects.toThrow(
            'Alarm error'
        )
        consoleErrorSpy.mockRestore()
    })

    it('should process alarm() when active tasks exist, when empty, and recover on errors', async () => {
        const fetchSpy = vi
            .spyOn(global, 'fetch')
            .mockResolvedValueOnce(new Response('ok') as any)

        mockStorage.sql.exec.mockReturnValueOnce({
            toArray: () => [
                { id: 1, callback_host: 'https://worker.example.com' },
            ],
        })

        await instance.alarm()
        expect(fetchSpy).toHaveBeenCalledWith(
            'https://worker.example.com/cron/callback',
            expect.objectContaining({
                method: 'POST',
            })
        )

        // Empty tasks
        mockStorage.sql.exec.mockReturnValueOnce({
            toArray: () => [],
        })
        await instance.alarm()

        // Fetch callback error -> schedules retry alarm
        const consoleErrorSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})
        mockStorage.sql.exec.mockReturnValueOnce({
            toArray: () => [
                { id: 1, callback_host: 'https://worker.example.com' },
            ],
        })
        fetchSpy.mockRejectedValueOnce(new Error('Webhook failed'))
        await instance.alarm()
        expect(mockStorage.setAlarm).toHaveBeenCalled()

        // Outer query error -> schedules retry alarm
        mockStorage.sql.exec.mockImplementationOnce(() => {
            throw new Error('DB alarm query failed')
        })
        await instance.alarm()
        expect(consoleErrorSpy).toHaveBeenCalled()

        consoleErrorSpy.mockRestore()
        fetchSpy.mockRestore()
    })

    it('should return statistics via getStatistics()', async () => {
        mockStorage.sql.exec.mockReturnValueOnce({
            toArray: () => [{ count: 42 }],
        })
        const stats = await instance.getStatistics()
        expect(stats).toEqual({
            databaseSize: 4096,
            activeConnections: 0,
            recentQueries: 42,
        })

        mockStorage.sql.exec.mockReturnValueOnce({
            toArray: () => [],
        })
        const emptyStats = await instance.getStatistics()
        expect(emptyStats.recentQueries).toBe(0)
    })

    it('should execute a query with params and support raw mode', async () => {
        const sql = 'SELECT * FROM users WHERE id = ?'
        const result = await instance.executeQuery({
            sql,
            params: [1],
            isRaw: false,
        })

        expect(mockStorage.sql.exec).toHaveBeenCalledWith(sql, 1)
        expect(result).toEqual([
            { id: 1, name: 'Alice' },
            { id: 2, name: 'Bob' },
        ])

        const rawResult = await instance.executeQuery({
            sql,
            params: [1],
            isRaw: true,
        })
        expect(rawResult).toEqual({
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

    it('should execute a transaction and handle transaction errors', async () => {
        const queries = [
            { sql: 'SELECT * FROM orders' },
            { sql: 'SELECT * FROM products' },
        ]
        const result = await instance.executeTransaction(queries, false)

        expect(mockStorage.sql.exec).toHaveBeenCalledTimes(2)
        expect(result.length).toBe(2)

        const consoleErrorSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})
        mockStorage.sql.exec.mockImplementationOnce(() => {
            throw new Error('Tx failed')
        })
        await expect(
            instance.executeTransaction([{ sql: 'BAD' }], false)
        ).rejects.toThrow('Tx failed')
        consoleErrorSpy.mockRestore()
    })

    it('should handle WebSocket /socket, /socket/broadcast, message, error, and close events', async () => {
        const badSocketReq = new Request('https://example.com/socket')
        const badSocketRes = await instance.fetch(badSocketReq)
        expect(badSocketRes.status).toBe(400)

        const wsReq = new Request(
            'https://example.com/socket?sessionId=session-123',
            {
                headers: { upgrade: 'websocket' },
            }
        )
        const wsRes = await instance.fetch(wsReq)
        expect(wsRes.status).toBe(101)
        expect(instance.connections.has('session-123')).toBe(true)

        const serverSocket = instance.connections.get('session-123')!

        // Trigger message and error listeners registered on serverSocket
        const addEventCalls = vi.mocked(serverSocket.addEventListener).mock
            .calls
        const messageHandler = addEventCalls.find(
            ([evt]) => evt === 'message'
        )?.[1] as any
        const errorHandler = addEventCalls.find(
            ([evt]) => evt === 'error'
        )?.[1] as any

        await messageHandler({
            data: JSON.stringify({
                action: 'query',
                sql: 'SELECT 1',
                params: [],
            }),
        })
        expect(serverSocket.send).toHaveBeenCalled()

        // Test broadcast to specific session and dead socket cleanup
        const deadSocket = new global.WebSocket('ws://localhost')
        vi.mocked(deadSocket.send).mockImplementation(() => {
            throw new Error('Socket closed')
        })
        instance.connections.set('dead-session', deadSocket)

        const broadcastAllReq = new Request(
            'https://example.com/socket/broadcast',
            {
                method: 'POST',
                body: JSON.stringify({ event: 'update' }),
            }
        )
        const broadcastRes = await instance.fetch(broadcastAllReq)
        expect(broadcastRes.status).toBe(200)
        expect(instance.connections.has('dead-session')).toBe(false)

        const broadcastTargetReq = new Request(
            'https://example.com/socket/broadcast?sessionId=other-session',
            {
                method: 'POST',
                body: JSON.stringify({ event: 'targeted' }),
            }
        )
        await instance.fetch(broadcastTargetReq)

        // Test webSocketClose and error listener cleanup
        const consoleErrorSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})
        errorHandler(new Error('WS error'))
        consoleErrorSpy.mockRestore()

        instance.connections.set('session-123', serverSocket)
        await instance.webSocketClose(serverSocket, 1000, 'Normal', true)
        expect(serverSocket.close).toHaveBeenCalledWith(
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
        const consoleErrorSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})

        mockStorage.sql.exec.mockImplementationOnce(() => {
            throw new Error('Query failed')
        })

        await expect(
            instance.executeQuery({ sql: 'INVALID QUERY' })
        ).rejects.toThrow('Query failed')
        consoleErrorSpy.mockRestore()
    })
})
