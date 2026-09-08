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
    var WebSocket: any
    var WebSocketPair: any
    var Response: any
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

    constructor(public url?: string) {}
}

global.WebSocketPair = vi.fn(() => {
    const client = new global.WebSocket('ws://localhost')
    const server = new global.WebSocket('ws://localhost')
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

function createCursor(rows: Record<string, any>[] = []) {
    return {
        columnNames: ['id', 'name'],
        raw: vi.fn().mockReturnValue([[1, 'Alice']]),
        toArray: vi.fn().mockReturnValue(rows),
        rowsRead: 2,
        rowsWritten: 0,
    }
}

function createInstance(cursor: any = createCursor()) {
    const storage = {
        sql: {
            exec: vi.fn().mockReturnValue(cursor),
            databaseSize: 1024,
        },
        getAlarm: vi.fn().mockResolvedValue(null),
        setAlarm: vi.fn().mockResolvedValue(undefined),
        deleteAlarm: vi.fn().mockResolvedValue(undefined),
        getTags: vi.fn().mockReturnValue([]),
    }

    const ctx = { storage, waitUntil: vi.fn(), getTags: vi.fn(() => []) }
    const env = { CLIENT_AUTHORIZATION_TOKEN: 'client-token' }

    const instance = new StarbaseDBDurableObject(ctx as any, env as any)
    return { instance, storage, ctx, env }
}

beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
})

describe('StarbaseDBDurableObject - advanced behaviors', () => {
    it('exposes bound rpc methods from init()', async () => {
        const { instance } = createInstance()
        const rpc = instance.init() as any

        expect(Object.keys(rpc).sort()).toEqual([
            'deleteAlarm',
            'executeQuery',
            'getAlarm',
            'getStatistics',
            'setAlarm',
        ])

        await rpc.getAlarm()
        expect((instance as any).storage.getAlarm).toHaveBeenCalled()
    })

    it('getAlarm returns the storage alarm', async () => {
        const { instance, storage } = createInstance()
        ;(storage.getAlarm as any).mockResolvedValue(12345)

        expect(await instance.getAlarm()).toBe(12345)
    })

    it('setAlarm accepts Date and number inputs and clamps to the future', async () => {
        const { instance, storage } = createInstance()

        const date = new Date(Date.now() + 5000)
        await instance.setAlarm(date)
        expect(storage.setAlarm).toHaveBeenLastCalledWith(
            date.getTime(),
            undefined
        )

        await instance.setAlarm(Date.now() + 20000)
        expect(storage.setAlarm).toHaveBeenLastCalledWith(
            Date.now() + 20000,
            undefined
        )

        await instance.setAlarm(Date.now() - 100000)
        const finalTime = (storage.setAlarm as any).mock.calls[2][0]
        expect(finalTime).toBeGreaterThanOrEqual(Date.now() + 900)
    })

    it('setAlarm rethrows storage failures', async () => {
        const { instance, storage } = createInstance()
        ;(storage.setAlarm as any).mockRejectedValue(new Error('nope'))

        await expect(instance.setAlarm(12345)).rejects.toThrow('nope')
    })

    it('deleteAlarm forwards options to storage', async () => {
        const { instance, storage } = createInstance()
        await instance.deleteAlarm({ allowUnfinished: true } as any)
        expect(storage.deleteAlarm).toHaveBeenCalledWith({
            allowUnfinished: true,
        })
    })

    it('getStatistics reports database size, connections, and query count', async () => {
        const cursor = createCursor([{ count: 7 }])
        const { instance } = createInstance(cursor)
        ;(instance as any).connections.set('session', new global.WebSocket())

        const stats = await instance.getStatistics()

        expect(stats.databaseSize).toBe(1024)
        expect(stats.activeConnections).toBe(1)
        expect(stats.recentQueries).toBe(7)
    })

    it('getStatistics falls back to zero when the query log is empty', async () => {
        const cursor = createCursor([])
        const { instance } = createInstance(cursor)

        const stats = await instance.getStatistics()
        expect(stats.recentQueries).toBe(0)
    })

    it('fetch rejects non-websocket upgrades to /socket', async () => {
        const { instance } = createInstance()
        const response = await instance.fetch(
            new Request('http://do/socket') as any
        )

        expect(response.status).toBe(400)
    })

    it('fetch upgrades websocket connections and registers the session', async () => {
        const { instance } = createInstance()
        const response = await instance.fetch(
            new Request('http://do/socket?sessionId=my-session', {
                headers: { upgrade: 'websocket' },
            }) as any
        )

        expect(response.status).toBe(101)
        expect(response.webSocket).toBeDefined()
        expect((instance as any).connections.has('my-session')).toBe(true)
    })

    it('clientConnected generates a session id when none is provided', async () => {
        const { instance } = createInstance()
        const response = await instance.clientConnected()

        expect(response.status).toBe(101)
        expect((instance as any).connections.size).toBe(1)
        const server = [...(instance as any).connections.values()][0]
        expect(server.addEventListener).toHaveBeenCalledWith(
            'message',
            expect.any(Function)
        )
        expect(server.addEventListener).toHaveBeenCalledWith(
            'error',
            expect.any(Function)
        )
    })

    it('broadcasts to every connection and cleans up broken ones', async () => {
        const { instance } = createInstance()
        const good = new global.WebSocket()
        const bad = new global.WebSocket()
        ;(bad.send as any).mockImplementation(() => {
            throw new Error('dead socket')
        })
        ;(instance as any).connections.set('good', good)
        ;(instance as any).connections.set('bad', bad)

        const response = await instance.fetch(
            new Request('http://do/socket/broadcast', {
                method: 'POST',
                body: JSON.stringify({ event: 'hello' }),
            }) as any
        )

        expect(response.status).toBe(200)
        expect(good.send).toHaveBeenCalledWith(
            JSON.stringify({ event: 'hello' })
        )
        expect((instance as any).connections.has('bad')).toBe(false)
        expect((instance as any).connections.has('good')).toBe(true)
    })

    it('broadcast targets only the requested session when one is specified', async () => {
        const { instance } = createInstance()
        const first = new global.WebSocket()
        const second = new global.WebSocket()
        ;(instance as any).connections.set('first', first)
        ;(instance as any).connections.set('second', second)

        await instance.fetch(
            new Request('http://do/socket/broadcast?sessionId=second', {
                method: 'POST',
                body: JSON.stringify({ event: 'private' }),
            }) as any
        )

        expect(first.send).not.toHaveBeenCalled()
        expect(second.send).toHaveBeenCalledWith(
            JSON.stringify({ event: 'private' })
        )
    })

    it('fetch returns 400 for unknown operations', async () => {
        const { instance } = createInstance()
        const response = await instance.fetch(
            new Request('http://do/other') as any
        )

        expect(response.status).toBe(400)
    })

    it('webSocketMessage executes queries for query actions', async () => {
        const { instance } = createInstance()
        const spy = vi
            .spyOn(instance as any, 'executeTransaction')
            .mockResolvedValue([{ id: 1 }])
        const ws = new global.WebSocket()

        await (instance as any).webSocketMessage(
            ws,
            JSON.stringify({ sql: 'SELECT 1', params: [], action: 'query' })
        )

        expect(spy).toHaveBeenCalledWith(
            [{ sql: 'SELECT 1', params: [] }],
            false
        )
        expect(ws.send).toHaveBeenCalledWith(JSON.stringify([{ id: 1 }]))
    })

    it('webSocketMessage ignores non-query actions', async () => {
        const { instance } = createInstance()
        const spy = vi.spyOn(instance as any, 'executeTransaction')
        const ws = new global.WebSocket()

        await (instance as any).webSocketMessage(
            ws,
            JSON.stringify({ action: 'other' })
        )

        expect(spy).not.toHaveBeenCalled()
    })

    it('webSocketClose closes the socket and removes tagged sessions', async () => {
        const { instance, ctx } = createInstance()
        ;(ctx.getTags as any).mockReturnValue(['session-1'])
        const ws = new global.WebSocket()
        ;(instance as any).connections.set('session-1', ws)

        await (instance as any).webSocketClose(ws, 1000, 'done', true)

        expect(ws.close).toHaveBeenCalledWith(
            1000,
            'StarbaseDB is closing WebSocket connection'
        )
        expect((instance as any).connections.has('session-1')).toBe(false)
    })

    it('webSocketClose keeps sessions without tags', async () => {
        const { instance } = createInstance()
        const ws = new global.WebSocket()
        ;(instance as any).connections.set('session-2', ws)

        await (instance as any).webSocketClose(ws, 1000, 'done', true)

        expect((instance as any).connections.has('session-2')).toBe(true)
    })

    it('executeQuery returns raw rows with metadata when isRaw is set', async () => {
        const cursor = createCursor()
        const { instance } = createInstance(cursor)

        const raw = await instance.executeQuery({
            sql: 'SELECT 1',
            isRaw: true,
        })

        expect(raw).toEqual({
            columns: cursor.columnNames,
            rows: [[1, 'Alice']],
            meta: { rows_read: 2, rows_written: 0 },
        })
    })

    it('executeQuery forwards params to the sql cursor', async () => {
        const { instance, storage } = createInstance()

        await instance.executeQuery({
            sql: 'SELECT * FROM users WHERE id = ?',
            params: [1],
        })
        expect(storage.sql.exec).toHaveBeenCalledWith(
            'SELECT * FROM users WHERE id = ?',
            1
        )

        await instance.executeQuery({ sql: 'SELECT 1' })
        expect(storage.sql.exec).toHaveBeenLastCalledWith('SELECT 1')
    })

    it('executeQuery rethrows sql execution failures', async () => {
        const { instance, storage } = createInstance()
        ;(storage.sql.exec as any).mockImplementation(() => {
            throw new Error('SQL parse error')
        })

        await expect(instance.executeQuery({ sql: 'BAD' })).rejects.toThrow(
            'SQL parse error'
        )
    })

    it('executeTransaction aggregates results across queries', async () => {
        const { instance } = createInstance()

        const results = await instance.executeTransaction(
            [{ sql: 'SELECT 1' }, { sql: 'SELECT 2' }],
            true
        )

        expect(results).toHaveLength(2)
    })

    it('executeTransaction rolls forward the error when a query fails', async () => {
        const { instance, storage } = createInstance()
        ;(storage.sql.exec as any).mockImplementation(() => {
            throw new Error('constraint violation')
        })

        await expect(
            instance.executeTransaction([{ sql: 'BAD' }], false)
        ).rejects.toThrow('constraint violation')
    })

    it('alarm exits early when there are no active cron tasks', async () => {
        const cursor = createCursor([])
        const { instance } = createInstance(cursor)
        const fetchSpy = vi.fn()
        vi.stubGlobal('fetch', fetchSpy)

        await (instance as any).alarm()

        expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('alarm calls the cron callback for active tasks', async () => {
        const cursor = createCursor([
            { callback_host: 'https://worker.example.com' },
        ])
        const { instance } = createInstance(cursor)
        const fetchSpy = vi.fn().mockResolvedValue(new Response('ok'))
        vi.stubGlobal('fetch', fetchSpy)

        await (instance as any).alarm()

        expect(fetchSpy).toHaveBeenCalledWith(
            'https://worker.example.com/cron/callback',
            expect.objectContaining({ method: 'POST' })
        )
    })

    it('alarm reschedules itself when the callback fails', async () => {
        const cursor = createCursor([
            { callback_host: 'https://worker.example.com' },
        ])
        const { instance, storage } = createInstance(cursor)
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')))

        await (instance as any).alarm()

        expect(storage.setAlarm).toHaveBeenCalled()
    })

    it('alarm reschedules itself when reading the tasks fails', async () => {
        const { instance, storage } = createInstance()
        vi.spyOn(instance as any, 'executeQuery').mockRejectedValue(
            new Error('sql down')
        )
        vi.stubGlobal('fetch', vi.fn())

        await (instance as any).alarm()

        expect(storage.setAlarm).toHaveBeenCalled()
    })
})
