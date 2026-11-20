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
    getAlarm: vi.fn().mockResolvedValue(12345),
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

const mockEnv = { CLIENT_AUTHORIZATION_TOKEN: 'client-token' } as any

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
        consoleErrorSpy.mockRestore()
    })

    it('should execute raw queries and parameterized queries', async () => {
        const rawResult = await instance.executeQuery({
            sql: 'SELECT * FROM users WHERE id = ?',
            params: [1],
            isRaw: true,
        })
        expect(mockStorage.sql.exec).toHaveBeenCalledWith(
            'SELECT * FROM users WHERE id = ?',
            1
        )
        expect(rawResult).toEqual({
            columns: ['id', 'name'],
            rows: [
                [1, 'Alice'],
                [2, 'Bob'],
            ],
            meta: { rows_read: 2, rows_written: 1 },
        })
    })

    it('should propagate errors from executeTransaction', async () => {
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

    it('should expose init RPC bindings and manage alarms', async () => {
        const rpc = instance.init()
        expect(await rpc.getAlarm()).toBe(12345)

        await rpc.setAlarm(Date.now() - 5000)
        expect(mockStorage.setAlarm).toHaveBeenCalled()

        await rpc.setAlarm(new Date(Date.now() + 60_000))
        expect(mockStorage.setAlarm).toHaveBeenCalledTimes(2)

        await rpc.deleteAlarm()
        expect(mockStorage.deleteAlarm).toHaveBeenCalled()
    })

    it('should handle setAlarm errors', async () => {
        const consoleErrorSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})
        mockStorage.setAlarm.mockRejectedValueOnce(new Error('alarm failed'))
        await expect(instance.setAlarm(Date.now() + 5000)).rejects.toThrow(
            'alarm failed'
        )
        consoleErrorSpy.mockRestore()
    })

    it('should run alarm callback for active cron tasks and schedule recovery on failure', async () => {
        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(new Response('ok') as any)
            .mockRejectedValueOnce(new Error('callback down'))
        const consoleErrorSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})

        mockStorage.sql.exec.mockReturnValueOnce({
            toArray: () => [],
        })
        await instance.alarm()
        expect(fetchSpy).not.toHaveBeenCalled()

        mockStorage.sql.exec.mockReturnValueOnce({
            toArray: () => [
                { id: 1, callback_host: 'https://worker.example.com' },
            ],
        })
        await instance.alarm()
        expect(fetchSpy).toHaveBeenCalledWith(
            'https://worker.example.com/cron/callback',
            expect.objectContaining({ method: 'POST' })
        )

        mockStorage.sql.exec.mockReturnValueOnce({
            toArray: () => [
                { id: 1, callback_host: 'https://worker.example.com' },
            ],
        })
        await instance.alarm()
        expect(mockStorage.setAlarm).toHaveBeenCalled()

        mockStorage.sql.exec.mockImplementationOnce(() => {
            throw new Error('DB query failed in alarm')
        })
        await instance.alarm()
        expect(mockStorage.setAlarm).toHaveBeenCalledTimes(2)

        fetchSpy.mockRestore()
        consoleErrorSpy.mockRestore()
    })

    it('should return database statistics', async () => {
        mockStorage.sql.exec.mockReturnValueOnce({
            toArray: () => [{ count: 7 }],
        })
        const stats = await instance.getStatistics()
        expect(stats).toEqual({
            databaseSize: 4096,
            activeConnections: 0,
            recentQueries: 7,
        })
    })

    it('should handle /socket upgrade, non-websocket /socket, /socket/broadcast, and webSocketMessage/Close', async () => {
        const badSocketRes = await instance.fetch(
            new Request('https://example.com/socket')
        )
        expect(badSocketRes.status).toBe(400)

        const wsRes = await instance.fetch(
            new Request('https://example.com/socket?sessionId=s1', {
                headers: { upgrade: 'websocket' },
            })
        )
        expect(wsRes.status).toBe(101)
        expect(instance.connections.has('s1')).toBe(true)

        const serverWs = instance.connections.get('s1')!
        await instance.webSocketMessage(
            serverWs,
            JSON.stringify({ action: 'query', sql: 'SELECT 1', params: [] })
        )
        expect(serverWs.send).toHaveBeenCalled()

        const bcastRes = await instance.fetch(
            new Request('https://example.com/socket/broadcast?sessionId=s1', {
                method: 'POST',
                body: JSON.stringify({ event: 'ping' }),
            })
        )
        expect(bcastRes.status).toBe(200)

        const otherWs = new global.WebSocket('ws://localhost')
        otherWs.send = vi.fn(() => {
            throw new Error('dead socket')
        })
        instance.connections.set('s2', otherWs)
        await instance.fetch(
            new Request('https://example.com/socket/broadcast', {
                method: 'POST',
                body: JSON.stringify({ event: 'all' }),
            })
        )
        expect(instance.connections.has('s2')).toBe(false)
        ;(instance as any).ctx = mockDurableObjectState
        instance.connections.set('session-123', serverWs)
        await instance.webSocketClose(serverWs, 1000, 'bye', true)
        expect(serverWs.close).toHaveBeenCalled()
        expect(instance.connections.has('session-123')).toBe(false)
    })
})
