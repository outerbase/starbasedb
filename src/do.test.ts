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

    it('should handle getAlarm, setAlarm, deleteAlarm', async () => {
        mockDurableObjectState.storage.getAlarm = vi
            .fn()
            .mockResolvedValue(12345)
        mockDurableObjectState.storage.setAlarm = vi
            .fn()
            .mockResolvedValue(undefined)
        mockDurableObjectState.storage.deleteAlarm = vi
            .fn()
            .mockResolvedValue(undefined)

        expect(await instance.getAlarm()).toBe(12345)

        await instance.setAlarm(new Date(Date.now() + 5000))
        expect(mockDurableObjectState.storage.setAlarm).toHaveBeenCalled()

        await instance.deleteAlarm()
        expect(mockDurableObjectState.storage.deleteAlarm).toHaveBeenCalled()
    })

    it('should handle alarm execution', async () => {
        mockStorage.sql.exec.mockReturnValueOnce({
            toArray: vi.fn().mockReturnValue([
                {
                    is_active: 1,
                    callback_host: 'http://localhost',
                },
            ]),
        })
        global.fetch = vi.fn().mockResolvedValue({ status: 200 } as any)

        await instance.alarm()
        expect(global.fetch).toHaveBeenCalled()
    })

    it('should handle alarm execution when task fails', async () => {
        mockStorage.sql.exec.mockReturnValueOnce({
            toArray: vi.fn().mockReturnValue([
                {
                    is_active: 1,
                    callback_host: 'http://localhost',
                },
            ]),
        })
        global.fetch = vi.fn().mockRejectedValue(new Error('Network error'))
        mockDurableObjectState.storage.setAlarm = vi.fn()

        await instance.alarm()
        expect(mockDurableObjectState.storage.setAlarm).toHaveBeenCalled() // Recovery alarm
    })

    it('should return statistics', async () => {
        instance.sql.databaseSize = 1024
        mockStorage.sql.exec.mockReturnValueOnce({
            toArray: vi.fn().mockReturnValue([{ count: 5 }]),
        })
        const stats = await instance.getStatistics()
        expect(stats.databaseSize).toBe(1024)
        expect(stats.activeConnections).toBe(0)
        expect(stats.recentQueries).toBe(5)
    })

    it('should reject /socket if not websocket upgrade', async () => {
        const request = new Request('http://localhost/socket')
        const response = await instance.fetch(request)
        expect(response.status).toBe(400)
    })

    it('should handle /socket with upgrade', async () => {
        const request = new Request('http://localhost/socket?sessionId=test', {
            headers: { upgrade: 'websocket' },
        })
        const response = await instance.fetch(request)
        expect(response.status).toBe(101)
        expect(instance.connections.has('test')).toBe(true)
    })

    it('should handle /socket/broadcast', async () => {
        const server = new global.WebSocket('ws://localhost')
        server.send = vi.fn()
        instance.connections.set('test1', server)

        const request = new Request('http://localhost/socket/broadcast', {
            method: 'POST',
            body: JSON.stringify({ msg: 'hello' }),
        })
        const response = await instance.fetch(request)
        expect(response.status).toBe(200)
        expect(server.send).toHaveBeenCalled()
    })

    it('should handle webSocketMessage', async () => {
        const ws = new global.WebSocket('ws://localhost')
        ws.send = vi.fn()
        await instance.webSocketMessage(
            ws,
            JSON.stringify({ action: 'query', sql: 'SELECT 1' })
        )
        expect(ws.send).toHaveBeenCalled()
    })

    it('should handle webSocketClose', async () => {
        const ws = new global.WebSocket('ws://localhost')
        ws.close = vi.fn()
        instance.ctx = mockDurableObjectState
        instance.connections.set('session-123', ws)
        await instance.webSocketClose(ws, 1000, 'done', true)
        expect(ws.close).toHaveBeenCalled()
        expect(instance.connections.has('session-123')).toBe(false)
    })

    it('should execute raw queries', async () => {
        const result = await instance.executeQuery({
            sql: 'SELECT 1',
            isRaw: true,
            params: [1],
        })
        expect(result).toHaveProperty('columns')
        expect(result).toHaveProperty('rows')
    })
})
