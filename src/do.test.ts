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

    it('should execute raw queries with columns and rows returned', async () => {
        const result = await instance.executeQuery({
            sql: 'SELECT * FROM users',
            isRaw: true,
        })

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

    it('should execute query with parameters', async () => {
        await instance.executeQuery({
            sql: 'SELECT * FROM users WHERE id = ?',
            params: [1],
        })

        expect(mockStorage.sql.exec).toHaveBeenCalledWith(
            'SELECT * FROM users WHERE id = ?',
            1
        )
    })

    it('should return 400 for /socket fetch request without websocket upgrade header', async () => {
        const req = new Request('https://example.com/socket')
        const res = await instance.fetch(req)

        expect(res.status).toBe(400)
    })

    it('should handle /socket fetch request with websocket upgrade header', async () => {
        const req = new Request('https://example.com/socket?sessionId=s1', {
            headers: { upgrade: 'websocket' },
        })
        const res = await instance.fetch(req)

        expect(res.status).toBe(101)
        expect(instance.connections.has('s1')).toBe(true)
    })

    it('should handle /socket/broadcast to all connections', async () => {
        const mockWs1 = { send: vi.fn() } as any
        const mockWs2 = { send: vi.fn() } as any
        instance.connections.set('c1', mockWs1)
        instance.connections.set('c2', mockWs2)

        const req = new Request('https://example.com/socket/broadcast', {
            method: 'POST',
            body: JSON.stringify({ event: 'ping' }),
        })
        const res = await instance.fetch(req)

        expect(res.status).toBe(200)
        expect(mockWs1.send).toHaveBeenCalledWith(JSON.stringify({ event: 'ping' }))
        expect(mockWs2.send).toHaveBeenCalledWith(JSON.stringify({ event: 'ping' }))
    })

    it('should handle /socket/broadcast targeted to a single sessionId', async () => {
        const mockWs1 = { send: vi.fn() } as any
        const mockWs2 = { send: vi.fn() } as any
        instance.connections.set('target-session', mockWs1)
        instance.connections.set('other-session', mockWs2)

        const req = new Request('https://example.com/socket/broadcast?sessionId=target-session', {
            method: 'POST',
            body: JSON.stringify({ event: 'target' }),
        })
        const res = await instance.fetch(req)

        expect(res.status).toBe(200)
        expect(mockWs1.send).toHaveBeenCalledWith(JSON.stringify({ event: 'target' }))
        expect(mockWs2.send).not.toHaveBeenCalled()
    })

    it('should clean up dead connections when broadcast fails', async () => {
        const deadWs = {
            send: vi.fn().mockImplementation(() => {
                throw new Error('Socket closed')
            }),
        } as any
        instance.connections.set('dead-session', deadWs)

        const req = new Request('https://example.com/socket/broadcast', {
            method: 'POST',
            body: JSON.stringify({ event: 'test' }),
        })
        const res = await instance.fetch(req)

        expect(res.status).toBe(200)
        expect(instance.connections.has('dead-session')).toBe(false)
    })

    it('should handle webSocketMessage query action', async () => {
        const mockWs = { send: vi.fn() } as any
        await instance.webSocketMessage(
            mockWs,
            JSON.stringify({ action: 'query', sql: 'SELECT 1', params: [] })
        )

        expect(mockWs.send).toHaveBeenCalled()
    })

    it('should handle webSocketClose and remove connection', async () => {
        const mockWs = { close: vi.fn() } as any
        instance.connections.set('session-123', mockWs)

        await instance.webSocketClose(mockWs, 1000, 'Normal closure', true)

        expect(mockWs.close).toHaveBeenCalledWith(
            1000,
            'StarbaseDB is closing WebSocket connection'
        )
        expect(instance.connections.has('session-123')).toBe(false)
    })

    it('should get statistics from database', async () => {
        mockStorage.sql.exec.mockReturnValueOnce({
            toArray: vi.fn().mockReturnValue([{ count: 42 }]),
        })

        const stats = await instance.getStatistics()

        expect(stats.recentQueries).toBe(42)
        expect(stats.activeConnections).toBe(0)
    })
})
