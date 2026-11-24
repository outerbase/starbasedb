import { describe, it, expect, vi, beforeEach } from 'vitest'
import { WebSocketPlugin } from './index'
import { StarbaseApp, StarbaseContext } from '../../src/handler'

type RegisteredHandler = (...args: any[]) => Response

function createMockApp() {
    const allHandlers: Record<string, RegisteredHandler[]> = {}
    const app = {
        all: vi.fn((path: string, handler: RegisteredHandler) => {
            allHandlers[path] = allHandlers[path] || []
            allHandlers[path].push(handler)
        }),
    } as unknown as StarbaseApp
    return { app, allHandlers }
}

function createMockContext(overrides: Record<string, any> = {}) {
    const store: Record<string, any> = {
        config: { role: 'admin' },
        dataSource: { rpc: { executeQuery: vi.fn() } },
        operations: { executeQuery: vi.fn().mockResolvedValue({ rows: [] }) },
        ...overrides,
    }
    return {
        get: vi.fn((key: string) => store[key]),
        req: {
            header: vi.fn((name: string) => {
                if (name === 'upgrade') return store.upgradeHeader
                return undefined
            }),
        },
    } as unknown as StarbaseContext
}

describe('WebSocketPlugin - Initialization', () => {
    it('should default to the /socket prefix', () => {
        const plugin = new WebSocketPlugin()
        expect(plugin['prefix']).toBe('/socket')
        expect(plugin.opts.requiresAuth).toBe(true)
    })

    it('should allow a custom prefix', () => {
        const plugin = new WebSocketPlugin({ prefix: '/custom-socket' })
        expect(plugin['prefix']).toBe('/custom-socket')
    })
})

describe('WebSocketPlugin - register()', () => {
    it('should register an all-methods handler on its prefix', async () => {
        const plugin = new WebSocketPlugin({ prefix: '/ws' })
        const { app, allHandlers } = createMockApp()

        await plugin.register(app)

        expect(app.all).toHaveBeenCalledWith('/ws', expect.any(Function))
        expect(allHandlers['/ws']).toHaveLength(1)
    })

    it('should reject requests without a websocket upgrade header', async () => {
        const plugin = new WebSocketPlugin()
        const { app, allHandlers } = createMockApp()
        await plugin.register(app)

        const context = createMockContext({ upgradeHeader: undefined })
        const response = allHandlers['/socket'][0](context)

        expect(response.status).toBe(400)
        expect(await response.text()).toBe('Expected upgrade request')
    })

    it('should reject requests with a non-websocket upgrade header', async () => {
        const plugin = new WebSocketPlugin()
        const { app, allHandlers } = createMockApp()
        await plugin.register(app)

        const context = createMockContext({ upgradeHeader: 'h2c' })
        const response = allHandlers['/socket'][0](context)

        expect(response.status).toBe(400)
        expect(await response.text()).toBe('Expected upgrade request')
    })

    it('should upgrade valid websocket requests with a 101 response', async () => {
        // Cloudflare Workers expose WebSocketPair as a global; stub it for the Node test env.
        class FakeWebSocket {
            accept = vi.fn()
            addEventListener = vi.fn()
            send = vi.fn()
        }
        const [client, server] = [new FakeWebSocket(), new FakeWebSocket()]
        ;(globalThis as any).WebSocketPair = class {
            constructor() {
                return { 0: client, 1: server }
            }
        }

        // Node's Response constructor rejects status 101, so stub a minimal
        // response class that captures what the Workers runtime provides.
        const originalResponse = globalThis.Response
        class FakeResponse {
            status: number
            webSocket: unknown
            constructor(_body: any, init?: any) {
                this.status = init?.status ?? 200
                this.webSocket = init?.webSocket
            }
            async text() {
                return ''
            }
        }
        ;(globalThis as any).Response = FakeResponse

        try {
            const plugin = new WebSocketPlugin()
            const { app, allHandlers } = createMockApp()
            await plugin.register(app)

            const context = createMockContext({ upgradeHeader: 'websocket' })
            const response = allHandlers['/socket'][0](context) as any

            expect(response.status).toBe(101)
            expect(response.webSocket).toBe(client)
            expect(server.accept).toHaveBeenCalledTimes(1)
        } finally {
            ;(globalThis as any).Response = originalResponse
            delete (globalThis as any).WebSocketPair
        }
    })
})

describe('WebSocketPlugin - message handling', () => {
    it('should execute SQL queries sent as query actions and return the result', async () => {
        const executeQuery = vi
            .fn()
            .mockResolvedValue({ rows: [{ id: 1 }] })
        class FakeWebSocket {
            accept = vi.fn()
            addEventListener = vi.fn()
            send = vi.fn()
        }
        const [client, server] = [new FakeWebSocket(), new FakeWebSocket()]
        ;(globalThis as any).WebSocketPair = class {
            constructor() {
                return { 0: client, 1: server }
            }
        }

        const plugin = new WebSocketPlugin()
        const connection = plugin.createConnection(
            createMockContext({
                operations: { executeQuery },
            }) as any
        )

        expect(connection).toBe(client)

        // Grab the 'message' listener the plugin registered on the server socket.
        const messageListener = server.addEventListener.mock.calls.find(
            ([event]: any) => event === 'message'
        )![1]

        messageListener({
            data: JSON.stringify({
                sql: 'SELECT * FROM users WHERE id = ?',
                params: [1],
                action: 'query',
            }),
        })

        await vi.waitFor(() => {
            expect(executeQuery).toHaveBeenCalledWith(
                expect.objectContaining({
                    sql: 'SELECT * FROM users WHERE id = ?',
                    params: [1],
                    isRaw: false,
                })
            )
        })
        await vi.waitFor(() => {
            expect(server.send).toHaveBeenCalledWith(
                JSON.stringify({ rows: [{ id: 1 }] })
            )
        })

        delete (globalThis as any).WebSocketPair
    })

    it('should ignore messages whose action is not a query', async () => {
        const executeQuery = vi.fn()
        class FakeWebSocket {
            accept = vi.fn()
            addEventListener = vi.fn()
            send = vi.fn()
        }
        const [client, server] = [new FakeWebSocket(), new FakeWebSocket()]
        ;(globalThis as any).WebSocketPair = class {
            constructor() {
                return { 0: client, 1: server }
            }
        }

        const plugin = new WebSocketPlugin()
        plugin.createConnection(createMockContext({ operations: { executeQuery } }) as any)

        const messageListener = server.addEventListener.mock.calls.find(
            ([event]: any) => event === 'message'
        )![1]

        messageListener({
            data: JSON.stringify({ action: 'ping' }),
        })

        // Flush the microtask queue before asserting nothing was executed.
        await Promise.resolve()
        expect(executeQuery).not.toHaveBeenCalled()
        expect(server.send).not.toHaveBeenCalled()

        delete (globalThis as any).WebSocketPair
    })
})

describe('WebSocketPlugin - sendMessage()', () => {
    it('should forward the message to the given client socket', () => {
        const plugin = new WebSocketPlugin()
        const client = { send: vi.fn() } as any

        plugin.sendMessage('hello', client)

        expect(client.send).toHaveBeenCalledWith('hello')
    })
})
