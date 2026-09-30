import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { StarbaseDBDurableObject } from './do'
vi.mock('cloudflare:workers', () => ({
    DurableObject: class {
        constructor(public ctx: any) {}
    },
}))
let instance: StarbaseDBDurableObject
let storage: any
let ctx: any
beforeEach(() => {
    storage = {
        getAlarm: vi.fn().mockResolvedValue(123),
        setAlarm: vi.fn().mockResolvedValue(undefined),
        deleteAlarm: vi.fn().mockResolvedValue(undefined),
        sql: {
            databaseSize: 4096,
            exec: vi.fn().mockReturnValue({
                columnNames: ['id'],
                rowsRead: 1,
                rowsWritten: 0,
                raw: () => [[7]],
                toArray: () => [{ id: 7 }],
            }),
        },
    }
    ctx = { storage, getTags: vi.fn().mockReturnValue([]) }
    instance = new StarbaseDBDurableObject(ctx, {
        CLIENT_AUTHORIZATION_TOKEN: 'client',
    } as any)
    vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
})
it('exposes bound RPC methods', async () => {
    const rpc = instance.init()
    expect(await rpc.getAlarm()).toBe(123)
    await rpc.deleteAlarm()
    expect(storage.deleteAlarm).toHaveBeenCalledOnce()
})
it.each([0, new Date(0), 5000])(
    'clamps alarm scheduling at least one second ahead: %s',
    async (time) => {
        vi.spyOn(Date, 'now').mockReturnValue(1000)
        await instance.setAlarm(time)
        expect(storage.setAlarm).toHaveBeenCalledWith(
            Math.max(Number(time), 2000),
            undefined
        )
    }
)
it('propagates scheduling failure', async () => {
    storage.setAlarm.mockRejectedValue(new Error('storage'))
    await expect(instance.setAlarm(5000)).rejects.toThrow('storage')
})
it('does not fetch a callback for an empty task queue', async () => {
    vi.spyOn(instance, 'executeQuery').mockResolvedValue([])
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    await instance.alarm()
    expect(fetcher).not.toHaveBeenCalled()
})
it('sends active tasks to the callback with client authorization', async () => {
    const tasks = [{ callback_host: 'https://callback.test', name: 'daily' }]
    vi.spyOn(instance, 'executeQuery').mockResolvedValue(tasks)
    const fetcher = vi.fn().mockResolvedValue(new Response())
    vi.stubGlobal('fetch', fetcher)
    await instance.alarm()
    expect(fetcher).toHaveBeenCalledWith(
        'https://callback.test/cron/callback',
        expect.objectContaining({
            method: 'POST',
            body: JSON.stringify(tasks),
            headers: expect.objectContaining({
                Authorization: 'Bearer client',
            }),
        })
    )
})
it.each(['callback', 'query'])(
    'reschedules after %s failure',
    async (stage) => {
        vi.spyOn(Date, 'now').mockReturnValue(1000)
        const query = vi.spyOn(instance, 'executeQuery')
        query.mockResolvedValue([{ callback_host: 'https://callback.test' }])
        if (stage === 'query') query.mockRejectedValue(new Error('query'))
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('callback')))
        await instance.alarm()
        expect(storage.setAlarm).toHaveBeenCalledWith(61000, undefined)
    }
)
it.each(['callback', 'query'])(
    'handles a failed recovery alarm after %s failure',
    async (stage) => {
        const query = vi.spyOn(instance, 'executeQuery')
        query.mockResolvedValue([{ callback_host: 'https://callback.test' }])
        if (stage === 'query') query.mockRejectedValue(new Error('query'))
        storage.setAlarm.mockRejectedValue(new Error('retry'))
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('callback')))
        await expect(instance.alarm()).resolves.toBeUndefined()
        expect(console.error).toHaveBeenCalledWith(
            'Failed to set recovery alarm:',
            expect.any(Error)
        )
    }
)
it.each([[{ count: '3' }], []].map((rows) => ({ rows })))(
    'reports statistics with available or empty query history %j',
    async ({ rows }) => {
        vi.spyOn(instance, 'executeQuery').mockResolvedValue(rows)
        instance.connections.set('one', {} as any)
        expect(await instance.getStatistics()).toEqual({
            databaseSize: 4096,
            activeConnections: 1,
            recentQueries: rows.length ? 3 : 0,
        })
    }
)
it('rejects a non-websocket socket request', async () => {
    expect(
        (await instance.fetch(new Request('https://test/socket'))).status
    ).toBe(400)
})
it.each(['?sessionId=s1', ''])(
    'passes optional session ID on upgrades %s',
    async (suffix) => {
        const connect = vi
            .spyOn(instance, 'clientConnected')
            .mockResolvedValue(new Response('upgrade'))
        await instance.fetch(
            new Request('https://test/socket' + suffix, {
                headers: { upgrade: 'websocket' },
            })
        )
        expect(connect).toHaveBeenCalledWith(suffix ? 's1' : undefined)
    }
)
it('targets one session and removes dead broadcast connections', async () => {
    const selected = { send: vi.fn() },
        other = { send: vi.fn() },
        dead = {
            send: vi.fn().mockImplementation(() => {
                throw new Error('closed')
            }),
        }
    instance.connections.set('selected', selected as any)
    instance.connections.set('other', other as any)
    await instance.fetch(
        new Request('https://test/socket/broadcast?sessionId=selected', {
            method: 'POST',
            body: '{"event":1}',
        })
    )
    expect(selected.send).toHaveBeenCalledWith('{"event":1}')
    expect(other.send).not.toHaveBeenCalled()
    instance.connections.set('dead', dead as any)
    await instance.fetch(
        new Request('https://test/socket/broadcast', {
            method: 'POST',
            body: '{}',
        })
    )
    expect(other.send).toHaveBeenCalledWith('{}')
    expect(instance.connections.has('dead')).toBe(false)
})
it('executes websocket query messages and ignores other actions', async () => {
    const execute = vi
        .spyOn(instance, 'executeTransaction')
        .mockResolvedValue([{ id: 1 }])
    const ws = { send: vi.fn() } as any
    await instance.webSocketMessage(
        ws,
        JSON.stringify({ action: 'query', sql: 'SELECT ?', params: [1] })
    )
    expect(execute).toHaveBeenCalledWith(
        [{ sql: 'SELECT ?', params: [1] }],
        false
    )
    expect(ws.send).toHaveBeenCalledWith('[{"id":1}]')
    await instance.webSocketMessage(ws, '{"action":"ping"}')
    expect(execute).toHaveBeenCalledOnce()
})
it.each([[], ['session']].map((tags) => ({ tags })))(
    'cleans tagged sockets on close %j',
    async ({ tags }) => {
        ctx.getTags.mockReturnValue(tags)
        instance.connections.set('session', {} as any)
        const ws = { close: vi.fn() } as any
        await instance.webSocketClose(ws, 1000, 'done', true)
        expect(ws.close).toHaveBeenCalledWith(
            1000,
            'StarbaseDB is closing WebSocket connection'
        )
        expect(instance.connections.has('session')).toBe(tags.length === 0)
    }
)
it.each([undefined, [], [7]].map((params) => ({ params })))(
    'returns raw rows and forwards optional parameters %j',
    async ({ params }) => {
        expect(
            await instance.executeQuery({
                sql: 'SELECT ?',
                params,
                isRaw: true,
            })
        ).toEqual({
            columns: ['id'],
            rows: [[7]],
            meta: { rows_read: 1, rows_written: 0 },
        })
        expect(storage.sql.exec).toHaveBeenLastCalledWith(
            'SELECT ?',
            ...(params || [])
        )
    }
)
it('stops transaction processing on query failure', async () => {
    const execute = vi
        .spyOn(instance, 'executeQuery')
        .mockRejectedValue(new Error('bad query'))
    await expect(
        instance.executeTransaction([{ sql: 'bad' }, { sql: 'later' }], false)
    ).rejects.toThrow('bad query')
    expect(execute).toHaveBeenCalledOnce()
})
