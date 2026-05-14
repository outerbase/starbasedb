import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebSocketPlugin } from './index'
import type { StarbaseApp, StarbaseContext } from '../../src/handler'
import type { DataSource } from '../../src/types'

type MessageListener = (event: { data: string }) => void

class MockWebSocket {
    accept = vi.fn()
    send = vi.fn()
    close = vi.fn()
    listeners = new Map<string, MessageListener[]>()

    addEventListener(event: string, listener: MessageListener) {
        const listeners = this.listeners.get(event) ?? []
        listeners.push(listener)
        this.listeners.set(event, listeners)
    }

    dispatchMessage(data: unknown) {
        const payload = typeof data === 'string' ? data : JSON.stringify(data)
        this.listeners
            .get('message')
            ?.forEach((listener) => listener({ data: payload }))
    }
}

class MockUpgradeResponse {
    body: BodyInit | null
    status: number
    webSocket?: MockWebSocket

    constructor(body: BodyInit | null = null, init?: ResponseInit) {
        this.body = body
        this.status = init?.status ?? 200
        this.webSocket = (
            init as { webSocket?: MockWebSocket } | undefined
        )?.webSocket
    }

    async text() {
        return typeof this.body === 'string' ? this.body : ''
    }
}

const OriginalResponse = globalThis.Response
let latestClient: MockWebSocket
let latestServer: MockWebSocket

function createContext(options?: {
    upgrade?: string
    executeQuery?: ReturnType<typeof vi.fn>
}) {
    const config = { role: 'admin' }
    const dataSource = { source: 'internal' } as DataSource
    const executeQuery =
        options?.executeQuery ??
        vi.fn().mockResolvedValue([{ id: 1, name: 'Ada' }])

    return {
        req: {
            header: vi.fn((name: string) =>
                name.toLowerCase() === 'upgrade' ? options?.upgrade : undefined
            ),
        },
        get: vi.fn((key: string) => {
            if (key === 'config') return config
            if (key === 'dataSource') return dataSource
            if (key === 'operations') {
                return {
                    executeQuery,
                }
            }

            return undefined
        }),
    } as unknown as StarbaseContext
}

beforeEach(() => {
    vi.clearAllMocks()
    globalThis.Response = MockUpgradeResponse as unknown as typeof Response
    globalThis.WebSocketPair = vi.fn(() => {
        latestClient = new MockWebSocket()
        latestServer = new MockWebSocket()

        return {
            0: latestClient,
            1: latestServer,
        }
    }) as unknown as typeof WebSocketPair
})

afterEach(() => {
    globalThis.Response = OriginalResponse
    vi.restoreAllMocks()
})

describe('WebSocketPlugin', () => {
    it('registers the default socket route', async () => {
        const app = {
            all: vi.fn(),
        } as unknown as StarbaseApp

        await new WebSocketPlugin().register(app)

        expect(app.all).toHaveBeenCalledWith('/socket', expect.any(Function))
    })

    it('registers a custom socket route', async () => {
        const app = {
            all: vi.fn(),
        } as unknown as StarbaseApp

        await new WebSocketPlugin({ prefix: '/events' }).register(app)

        expect(app.all).toHaveBeenCalledWith('/events', expect.any(Function))
    })

    it('rejects non-upgrade requests before opening a socket pair', async () => {
        let handler: ((context: StarbaseContext) => Response) | undefined
        const app = {
            all: vi.fn((_: string, routeHandler) => {
                handler = routeHandler
            }),
        } as unknown as StarbaseApp

        await new WebSocketPlugin().register(app)
        const response = handler?.(createContext())

        expect(response?.status).toBe(400)
        await expect(response?.text()).resolves.toBe('Expected upgrade request')
        expect(globalThis.WebSocketPair).not.toHaveBeenCalled()
    })

    it('upgrades websocket route requests and accepts the server socket', async () => {
        let handler: ((context: StarbaseContext) => Response) | undefined
        const app = {
            all: vi.fn((_: string, routeHandler) => {
                handler = routeHandler
            }),
        } as unknown as StarbaseApp

        await new WebSocketPlugin().register(app)
        const response = handler?.(createContext({ upgrade: 'websocket' }))

        expect(response?.status).toBe(101)
        expect(response?.webSocket).toBe(latestClient)
        expect(latestServer.accept).toHaveBeenCalledOnce()
        expect(latestServer.listeners.get('message')).toHaveLength(1)
    })

    it('executes query messages and sends the serialized result', async () => {
        const executeQuery = vi
            .fn()
            .mockResolvedValue([{ id: 7, name: 'Grace' }])
        const context = createContext({ executeQuery })

        const client = new WebSocketPlugin().createConnection(context)
        latestServer.dispatchMessage({
            action: 'query',
            sql: 'SELECT * FROM users WHERE id = ?',
            params: [7],
        })

        await vi.waitFor(() => {
            expect(executeQuery).toHaveBeenCalledWith({
                sql: 'SELECT * FROM users WHERE id = ?',
                params: [7],
                isRaw: false,
                dataSource: { source: 'internal' },
                config: { role: 'admin' },
            })
            expect(latestServer.send).toHaveBeenCalledWith(
                JSON.stringify([{ id: 7, name: 'Grace' }])
            )
        })
        expect(client).toBe(latestClient)
    })

    it('ignores non-query messages', async () => {
        const executeQuery = vi.fn()

        new WebSocketPlugin().createConnection(createContext({ executeQuery }))
        latestServer.dispatchMessage({
            action: 'ping',
            sql: 'SELECT 1',
        })

        await Promise.resolve()

        expect(executeQuery).not.toHaveBeenCalled()
        expect(latestServer.send).not.toHaveBeenCalled()
    })

    it('sends messages through the provided client socket', () => {
        const client = new MockWebSocket()

        new WebSocketPlugin().sendMessage(
            'hello subscribers',
            client as unknown as WebSocket
        )

        expect(client.send).toHaveBeenCalledWith('hello subscribers')
    })
})
