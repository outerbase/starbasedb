import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { WebSocketPlugin } from './index'
import type { StarbaseApp, StarbaseDBConfiguration } from '../../src/handler'
import type { DataSource } from '../../src/types'

type MessageHandler = (event: { data: string }) => void

class FakeSocket {
    accepted = false
    sent: string[] = []
    private listeners = new Map<string, MessageHandler[]>()

    accept() {
        this.accepted = true
    }

    send(message: string) {
        this.sent.push(message)
    }

    addEventListener(event: string, handler: MessageHandler) {
        const handlers = this.listeners.get(event) ?? []
        handlers.push(handler)
        this.listeners.set(event, handlers)
    }

    dispatchMessage(data: string) {
        for (const handler of this.listeners.get('message') ?? []) {
            handler({ data })
        }
    }
}

type CapturedSocketPair = {
    client: FakeSocket
    server: FakeSocket
}

let lastSocketPair: CapturedSocketPair | undefined

class FakeWebSocketPair {
    0: FakeSocket
    1: FakeSocket

    constructor() {
        const client = new FakeSocket()
        const server = new FakeSocket()

        this[0] = client
        this[1] = server
        lastSocketPair = { client, server }
    }
}

type CapturedRoute = {
    path?: string
    handler?: (c: any) => Response
}

function createAppHarness() {
    const captured: CapturedRoute = {}
    const app = {
        all: vi.fn((path, handler) => {
            captured.path = path
            captured.handler = handler
        }),
    } as unknown as StarbaseApp

    return { app, captured }
}

function createContext(opts?: {
    upgradeHeader?: string
    executeQuery?: ReturnType<typeof vi.fn>
    queryResponse?: unknown
}) {
    const config = { role: 'admin' } as StarbaseDBConfiguration
    const dataSource = { source: 'internal' } as DataSource
    const executeQuery =
        opts?.executeQuery ??
        vi.fn().mockResolvedValue(opts?.queryResponse ?? { result: [] })

    return {
        config,
        dataSource,
        executeQuery,
        context: {
            get: vi.fn((key: string) => {
                if (key === 'config') return config
                if (key === 'dataSource') return dataSource
                if (key === 'operations') return { executeQuery }
                return undefined
            }),
            req: {
                header: vi.fn((key: string) =>
                    key === 'upgrade' ? opts?.upgradeHeader : undefined
                ),
            },
        },
    }
}

async function flushWebSocketMessage() {
    await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('WebSocketPlugin', () => {
    beforeEach(() => {
        lastSocketPair = undefined
        vi.stubGlobal('WebSocketPair', FakeWebSocketPair)
    })

    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it('registers the default socket route', async () => {
        const plugin = new WebSocketPlugin()
        const { app, captured } = createAppHarness()

        await plugin.register(app)

        expect(app.all).toHaveBeenCalledTimes(1)
        expect(captured.path).toBe('/socket')
        expect(captured.handler).toBeInstanceOf(Function)
    })

    it('allows a custom socket route prefix', async () => {
        const plugin = new WebSocketPlugin({ prefix: '/db/socket' })
        const { app, captured } = createAppHarness()

        await plugin.register(app)

        expect(app.all).toHaveBeenCalledWith('/db/socket', expect.any(Function))
        expect(captured.path).toBe('/db/socket')
    })

    it('rejects non-websocket upgrade requests', async () => {
        const plugin = new WebSocketPlugin()
        const { app, captured } = createAppHarness()
        const { context } = createContext({ upgradeHeader: 'not-websocket' })

        await plugin.register(app)

        const response = captured.handler!(context)

        expect(response.status).toBe(400)
        expect(await response.text()).toBe('Expected upgrade request')
        expect(lastSocketPair).toBeUndefined()
    })

    it('executes query messages and sends the serialized response', async () => {
        const plugin = new WebSocketPlugin()
        const queryResponse = { result: [{ id: 1, name: 'Ada' }] }
        const { config, dataSource, executeQuery, context } = createContext({
            queryResponse,
        })

        const client = plugin.createConnection(context as any)
        lastSocketPair!.server.dispatchMessage(
            JSON.stringify({
                action: 'query',
                sql: 'SELECT * FROM users WHERE id = ?',
                params: [1],
            })
        )
        await flushWebSocketMessage()

        expect(client).toBe(lastSocketPair!.client)
        expect(lastSocketPair!.server.accepted).toBe(true)
        expect(executeQuery).toHaveBeenCalledWith({
            sql: 'SELECT * FROM users WHERE id = ?',
            params: [1],
            isRaw: false,
            dataSource,
            config,
        })
        expect(lastSocketPair!.server.sent).toEqual([
            JSON.stringify(queryResponse),
        ])
    })

    it('does not execute queries for unrelated message actions', async () => {
        const plugin = new WebSocketPlugin()
        const { executeQuery, context } = createContext()

        plugin.createConnection(context as any)
        lastSocketPair!.server.dispatchMessage(
            JSON.stringify({
                action: 'subscribe',
                sql: 'SELECT * FROM users',
                params: [],
            })
        )
        await flushWebSocketMessage()

        expect(executeQuery).not.toHaveBeenCalled()
        expect(lastSocketPair!.server.sent).toEqual([])
    })

    it('delegates outgoing messages to the client socket', () => {
        const plugin = new WebSocketPlugin()
        const client = new FakeSocket()

        plugin.sendMessage('ready', client as unknown as WebSocket)

        expect(client.sent).toEqual(['ready'])
    })
})
