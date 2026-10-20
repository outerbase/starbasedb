import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WebSocketPlugin } from './index'
import { Hono } from 'hono'
import type { DataSource } from '../../src/types'
import type { StarbaseDBConfiguration } from '../../src/handler'

declare global {
    var WebSocket: any
    var WebSocketPair: any
    var Response: any
}

const OriginalResponse = globalThis.Response

class MockCloudflareResponse {
    body: any
    status: number
    webSocket: any
    constructor(body?: any, init?: any) {
        this.body = body
        this.status = init?.status ?? 200
        this.webSocket = init?.webSocket
    }
    text() {
        return Promise.resolve(String(this.body ?? ''))
    }
}

describe('WebSocketPlugin', () => {
    let plugin: WebSocketPlugin
    let mockDataSource: DataSource
    let mockConfig: StarbaseDBConfiguration
    let mockExecuteQuery: any
    let mockClientWs: any
    let mockServerWs: any

    beforeEach(() => {
        vi.clearAllMocks()
        global.Response = MockCloudflareResponse as any

        mockExecuteQuery = vi.fn().mockResolvedValue([{ id: 1, name: 'Alice' }])

        mockConfig = {
            role: 'client',
            outerbaseApiKey: 'ws-key',
        }

        mockDataSource = {
            source: 'internal',
            rpc: {
                executeQuery: mockExecuteQuery,
            } as any,
        }

        mockClientWs = {
            send: vi.fn(),
            close: vi.fn(),
        }

        mockServerWs = {
            accept: vi.fn(),
            send: vi.fn(),
            addEventListener: vi.fn(),
        }

        global.WebSocketPair = vi.fn().mockImplementation(() => ({
            0: mockClientWs,
            1: mockServerWs,
        }))

        plugin = new WebSocketPlugin({ prefix: '/custom-socket' })
    })

    afterEach(() => {
        global.Response = OriginalResponse
    })

    describe('Initialization & Registration', () => {
        it('should initialize with custom prefix and default options', () => {
            expect(plugin.name).toBe('starbasedb:websocket')
            expect(plugin.opts.requiresAuth).toBe(true)
            expect(plugin['prefix']).toBe('/custom-socket')
        })

        it('should default to /socket prefix when no option provided', () => {
            const defaultPlugin = new WebSocketPlugin()
            expect(defaultPlugin['prefix']).toBe('/socket')
        })
    })

    describe('HTTP to WebSocket Upgrade', () => {
        it('should reject non-websocket upgrade requests with 400', async () => {
            const app = new Hono<any>()
            app.use('*', async (c, next) => {
                c.set('config', mockConfig)
                c.set('dataSource', mockDataSource)
                c.set('operations', { executeQuery: mockExecuteQuery })
                await next()
            })

            await plugin.register(app as any)

            const res = await app.request('http://localhost/custom-socket', {
                method: 'GET',
                headers: {},
            })

            expect(res.status).toBe(400)
            expect(await res.text()).toBe('Expected upgrade request')
        })

        it('should upgrade request when upgrade header is websocket', async () => {
            const app = new Hono<any>()
            app.use('*', async (c, next) => {
                c.set('config', mockConfig)
                c.set('dataSource', mockDataSource)
                c.set('operations', { executeQuery: mockExecuteQuery })
                await next()
            })

            await plugin.register(app as any)

            const res = await app.request('http://localhost/custom-socket', {
                method: 'GET',
                headers: {
                    upgrade: 'websocket',
                },
            })

            expect(res.status).toBe(101)
            expect(mockServerWs.accept).toHaveBeenCalled()
            expect(mockServerWs.addEventListener).toHaveBeenCalledWith(
                'message',
                expect.any(Function)
            )
        })
    })

    describe('sendMessage helper', () => {
        it('should invoke send on client WebSocket', () => {
            plugin.sendMessage('hello from server', mockClientWs)
            expect(mockClientWs.send).toHaveBeenCalledWith('hello from server')
        })
    })

    describe('Message event processing', () => {
        it('should handle query action and execute query', async () => {
            const app = new Hono<any>()
            app.use('*', async (c, next) => {
                c.set('config', mockConfig)
                c.set('dataSource', mockDataSource)
                c.set('operations', { executeQuery: mockExecuteQuery })
                await next()
            })

            await plugin.register(app as any)

            await app.request('http://localhost/custom-socket', {
                method: 'GET',
                headers: {
                    upgrade: 'websocket',
                },
            })

            const messageHandler =
                mockServerWs.addEventListener.mock.calls.find(
                    (call: any[]) => call[0] === 'message'
                )[1]

            await messageHandler({
                data: JSON.stringify({
                    action: 'query',
                    sql: 'SELECT * FROM users',
                    params: [],
                }),
            })

            expect(mockExecuteQuery).toHaveBeenCalledWith({
                sql: 'SELECT * FROM users',
                params: [],
                isRaw: false,
                dataSource: mockDataSource,
                config: mockConfig,
            })
            expect(mockServerWs.send).toHaveBeenCalledWith(
                JSON.stringify([{ id: 1, name: 'Alice' }])
            )
        })
    })
})
