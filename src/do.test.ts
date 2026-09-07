import { describe, expect, it, vi, beforeEach } from 'vitest'
import { StarbaseDBDurableObject } from './do'

vi.mock('cloudflare:workers', () => {
    return {
        DurableObject: class MockDurableObject {
            ctx: unknown
            env: unknown
            constructor(ctx: unknown, env: unknown) {
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
        databaseSize: 2048,
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
    getAlarm: vi.fn().mockResolvedValue(null),
    setAlarm: vi.fn().mockResolvedValue(undefined),
    deleteAlarm: vi.fn().mockResolvedValue(undefined),
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

    it('executes parameterized and raw queries', async () => {
        await instance.executeQuery({
            sql: 'SELECT * FROM users WHERE id = ?',
            params: [1],
        })
        expect(mockStorage.sql.exec).toHaveBeenCalledWith(
            'SELECT * FROM users WHERE id = ?',
            1
        )

        const raw = await instance.executeQuery({
            sql: 'SELECT * FROM users',
            isRaw: true,
        })
        expect(raw).toEqual({
            columns: ['id', 'name'],
            rows: [
                [1, 'Alice'],
                [2, 'Bob'],
            ],
            meta: { rows_read: 2, rows_written: 1 },
        })
    })

    it('exposes RPC helpers from init()', () => {
        const rpc = instance.init()
        expect(Object.keys(rpc)).toEqual([
            'getAlarm',
            'setAlarm',
            'deleteAlarm',
            'getStatistics',
            'executeQuery',
        ])
    })

    it('clamps alarm times into the future', async () => {
        await instance.setAlarm(Date.now() - 10_000)
        expect(mockStorage.setAlarm).toHaveBeenCalledWith(
            expect.any(Number),
            undefined
        )
        const scheduled = mockStorage.setAlarm.mock.calls[0][0]
        expect(scheduled).toBeGreaterThan(Date.now())

        await instance.setAlarm(new Date(Date.now() + 60_000), {
            allowConcurrency: true,
        } as any)
        expect(mockStorage.setAlarm).toHaveBeenCalledTimes(2)

        await instance.deleteAlarm()
        expect(mockStorage.deleteAlarm).toHaveBeenCalled()
        await expect(instance.getAlarm()).resolves.toBeNull()
    })

    it('rethrows setAlarm failures', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        mockStorage.setAlarm.mockRejectedValueOnce(new Error('alarm quota'))

        await expect(instance.setAlarm(Date.now() + 5000)).rejects.toThrow(
            'alarm quota'
        )
    })

    it('returns statistics including recent query counts', async () => {
        mockStorage.sql.exec.mockReturnValueOnce({
            columnNames: ['count'],
            raw: vi.fn(),
            toArray: vi.fn().mockReturnValue([{ count: 4 }]),
            rowsRead: 1,
            rowsWritten: 0,
        })

        const stats = await instance.getStatistics()
        expect(stats).toEqual({
            databaseSize: 2048,
            activeConnections: 0,
            recentQueries: 4,
        })
    })

    it('no-ops the alarm when no cron tasks are active', async () => {
        mockStorage.sql.exec.mockReturnValueOnce({
            toArray: vi.fn().mockReturnValue([]),
        })

        await instance.alarm()
        expect(mockStorage.setAlarm).not.toHaveBeenCalled()
    })

    it('posts active cron tasks to the callback host', async () => {
        const fetchMock = vi
            .spyOn(global, 'fetch')
            .mockResolvedValueOnce(new Response('ok') as any)
        mockStorage.sql.exec.mockReturnValueOnce({
            toArray: vi.fn().mockReturnValue([
                {
                    callback_host: 'https://worker.example',
                    name: 'nightly',
                    is_active: 1,
                },
            ]),
        })

        await instance.alarm()

        expect(fetchMock).toHaveBeenCalledWith(
            'https://worker.example/cron/callback',
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({
                    Authorization: 'Bearer client-token',
                }),
            })
        )
    })

    it('reschedules the alarm when the cron callback fails', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('offline'))
        mockStorage.sql.exec.mockReturnValueOnce({
            toArray: vi
                .fn()
                .mockReturnValue([
                    { callback_host: 'https://worker.example', is_active: 1 },
                ]),
        })

        await instance.alarm()
        expect(mockStorage.setAlarm).toHaveBeenCalled()
    })

    it('reschedules when loading cron tasks fails', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        vi.spyOn(instance, 'executeQuery').mockRejectedValueOnce(
            new Error('sql down')
        )

        await instance.alarm()
        expect(mockStorage.setAlarm).toHaveBeenCalled()
    })

    it('upgrades websocket requests and rejects non-upgrade socket fetches', async () => {
        const upgraded = await instance.fetch(
            new Request('https://example.com/socket?sessionId=abc', {
                headers: { upgrade: 'websocket' },
            })
        )
        expect(upgraded.status).toBe(101)
        expect(instance.connections.has('abc')).toBe(true)

        const rejected = await instance.fetch(
            new Request('https://example.com/socket')
        )
        expect(rejected.status).toBe(400)
        expect(rejected.body).toBe('Expected WebSocket')
    })

    it('broadcasts to all sessions or a targeted session', async () => {
        const first = { send: vi.fn() }
        const second = { send: vi.fn() }
        instance.connections.set('one', first as any)
        instance.connections.set('two', second as any)

        await instance.fetch(
            new Request('https://example.com/socket/broadcast', {
                method: 'POST',
                body: JSON.stringify({ hello: 'all' }),
            })
        )
        expect(first.send).toHaveBeenCalled()
        expect(second.send).toHaveBeenCalled()

        first.send.mockClear()
        second.send.mockClear()

        await instance.fetch(
            new Request('https://example.com/socket/broadcast?sessionId=two', {
                method: 'POST',
                body: JSON.stringify({ hello: 'two' }),
            })
        )
        expect(first.send).not.toHaveBeenCalled()
        expect(second.send).toHaveBeenCalled()
    })

    it('drops dead websocket connections during broadcast', async () => {
        const dead = {
            send: vi.fn(() => {
                throw new Error('closed')
            }),
        }
        instance.connections.set('dead', dead as any)

        const response = await instance.fetch(
            new Request('https://example.com/socket/broadcast', {
                method: 'POST',
                body: JSON.stringify({ ping: true }),
            })
        )

        expect(response.status).toBe(200)
        expect(instance.connections.has('dead')).toBe(false)
    })

    it('creates a session id when one is not provided', async () => {
        const response = await instance.clientConnected()
        expect(response.status).toBe(101)
        expect(instance.connections.size).toBe(1)
    })

    it('executes websocket query messages and closes tagged sockets', async () => {
        const ws = { send: vi.fn(), close: vi.fn() } as any
        vi.spyOn(instance, 'executeTransaction').mockResolvedValue([{ id: 1 }])

        await instance.webSocketMessage(
            ws,
            JSON.stringify({
                action: 'query',
                sql: 'SELECT 1',
                params: [],
            })
        )
        expect(ws.send).toHaveBeenCalledWith(JSON.stringify([{ id: 1 }]))

        instance.connections.set('session-123', ws)
        await instance.webSocketClose(ws, 1000, 'done', true)
        expect(ws.close).toHaveBeenCalled()
        expect(instance.connections.has('session-123')).toBe(false)
    })

    it('rethrows transaction errors', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        vi.spyOn(instance, 'executeQuery').mockRejectedValueOnce(
            new Error('tx failed')
        )

        await expect(
            instance.executeTransaction([{ sql: 'SELECT 1' }], false)
        ).rejects.toThrow('tx failed')
    })
})
