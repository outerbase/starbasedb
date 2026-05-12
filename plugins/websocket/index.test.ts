import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocketPlugin } from './index'
import type { DataSource } from '../../src/types'

type FakeMessageEvent = {
    data: string
}

class FakeWebSocket {
    accepted = false
    sentMessages: string[] = []
    listeners: Record<string, Array<(event: FakeMessageEvent) => void>> = {}

    accept() {
        this.accepted = true
    }

    send(message: string) {
        this.sentMessages.push(message)
    }

    addEventListener(
        eventName: string,
        listener: (event: FakeMessageEvent) => void
    ) {
        this.listeners[eventName] ??= []
        this.listeners[eventName].push(listener)
    }

    dispatchMessage(data: unknown) {
        for (const listener of this.listeners.message ?? []) {
            listener({ data: JSON.stringify(data) })
        }
    }
}

let lastPair:
    | {
          client: FakeWebSocket
          server: FakeWebSocket
      }
    | undefined

function installWebSocketPairMock() {
    vi.stubGlobal(
        'WebSocketPair',
        vi.fn(() => {
            lastPair = {
                client: new FakeWebSocket(),
                server: new FakeWebSocket(),
            }
            return {
                0: lastPair.client,
                1: lastPair.server,
            }
        })
    )
}

function createContext(opts?: {
    executeQuery?: ReturnType<typeof vi.fn>
    dataSource?: DataSource
}) {
    const config = { role: 'admin' }
    const dataSource =
        opts?.dataSource ??
        ({
            rpc: {
                executeQuery: vi.fn(),
            },
        } as unknown as DataSource)
    const executeQuery =
        opts?.executeQuery ??
        vi.fn().mockResolvedValue({ result: [{ id: 1 }], error: undefined })
    const values = {
        config,
        dataSource,
        operations: {
            executeQuery,
        },
    }

    return {
        context: {
            get: vi.fn((key: keyof typeof values) => values[key]),
        },
        config,
        dataSource,
        executeQuery,
    }
}

describe('WebSocketPlugin', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        lastPair = undefined
        installWebSocketPairMock()
    })

    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it('registers the default socket route and rejects non-upgrade requests', async () => {
        const app = new Hono()
        const plugin = new WebSocketPlugin()

        await plugin.register(app as any)

        const response = await app.request('/socket')

        expect(response.status).toBe(400)
        await expect(response.text()).resolves.toBe('Expected upgrade request')
    })

    it('registers a custom socket route prefix', async () => {
        const app = new Hono()
        const plugin = new WebSocketPlugin({ prefix: '/live-query' })

        await plugin.register(app as any)

        const response = await app.request('/live-query')

        expect(response.status).toBe(400)
        await expect(response.text()).resolves.toBe('Expected upgrade request')
    })

    it('accepts WebSocketPair server connections and returns the client socket', () => {
        const plugin = new WebSocketPlugin()
        const { context } = createContext()

        const client = plugin.createConnection(context as any)

        expect(client).toBe(lastPair?.client)
        expect(lastPair?.server.accepted).toBe(true)
        expect(lastPair?.server.listeners.message).toHaveLength(1)
    })

    it('sends messages through the provided client socket', () => {
        const plugin = new WebSocketPlugin()
        const client = new FakeWebSocket()

        plugin.sendMessage('hello websocket', client as unknown as WebSocket)

        expect(client.sentMessages).toEqual(['hello websocket'])
    })

    it('executes query messages and sends serialized results to the server socket', async () => {
        const plugin = new WebSocketPlugin()
        const executeQuery = vi
            .fn()
            .mockResolvedValue({ result: [{ name: 'Ada' }], error: undefined })
        const { context, config, dataSource } = createContext({ executeQuery })

        plugin.createConnection(context as any)
        lastPair?.server.dispatchMessage({
            action: 'query',
            sql: 'SELECT * FROM users WHERE id = ?',
            params: [1],
        })
        await vi.waitFor(() => expect(executeQuery).toHaveBeenCalledTimes(1))

        expect(executeQuery).toHaveBeenCalledWith({
            sql: 'SELECT * FROM users WHERE id = ?',
            params: [1],
            isRaw: false,
            dataSource,
            config,
        })
        expect(lastPair?.server.sentMessages).toEqual([
            JSON.stringify({ result: [{ name: 'Ada' }], error: undefined }),
        ])
    })

    it('ignores non-query WebSocket actions', async () => {
        const plugin = new WebSocketPlugin()
        const executeQuery = vi.fn()
        const { context } = createContext({ executeQuery })

        plugin.createConnection(context as any)
        lastPair?.server.dispatchMessage({
            action: 'ping',
            sql: 'SELECT 1',
        })
        await new Promise((resolve) => setTimeout(resolve, 0))

        expect(executeQuery).not.toHaveBeenCalled()
        expect(lastPair?.server.sentMessages).toEqual([])
    })
})
