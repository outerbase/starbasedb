import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { ChangeDataCapturePlugin } from './index'
import { StarbaseDBConfiguration } from '../../src/handler'

const parser = new (require('node-sql-parser').Parser)()

let cdcPlugin: ChangeDataCapturePlugin
let mockDurableObjectStub: any
let mockConfig: StarbaseDBConfiguration

beforeEach(() => {
    vi.clearAllMocks()
    mockDurableObjectStub = {
        fetch: vi.fn().mockResolvedValue(new Response('OK', { status: 200 })),
    }

    mockConfig = {
        role: 'admin',
    } as any

    cdcPlugin = new ChangeDataCapturePlugin({
        stub: mockDurableObjectStub,
        broadcastAllEvents: false,
        events: [
            { action: 'INSERT', schema: 'public', table: 'users' },
            { action: 'DELETE', schema: 'public', table: 'orders' },
        ],
    })
})

beforeEach(() => {
    vi.clearAllMocks()
    mockDurableObjectStub = {
        fetch: vi.fn(),
    }

    mockConfig = {
        role: 'admin',
    } as any

    cdcPlugin = new ChangeDataCapturePlugin({
        stub: mockDurableObjectStub,
        broadcastAllEvents: false,
        events: [
            { action: 'INSERT', schema: 'public', table: 'users' },
            { action: 'DELETE', schema: 'public', table: 'orders' },
        ],
    })
})

describe('ChangeDataCapturePlugin - Initialization', () => {
    it('should initialize correctly with given options', () => {
        expect(cdcPlugin.prefix).toBe('/cdc')
        expect(cdcPlugin.broadcastAllEvents).toBe(false)
        expect(cdcPlugin.listeningEvents).toHaveLength(2)
    })

    it('should allow all events when broadcastAllEvents is true', () => {
        const plugin = new ChangeDataCapturePlugin({
            stub: mockDurableObjectStub,
            broadcastAllEvents: true,
        })

        expect(plugin.broadcastAllEvents).toBe(true)
        expect(plugin.listeningEvents).toBeUndefined()
    })
})

describe('ChangeDataCapturePlugin - isEventMatch', () => {
    it('should return true for matching event', () => {
        expect(cdcPlugin.isEventMatch('INSERT', 'public', 'users')).toBe(true)
        expect(cdcPlugin.isEventMatch('DELETE', 'public', 'orders')).toBe(true)
    })

    it('should return false for non-matching event', () => {
        expect(cdcPlugin.isEventMatch('UPDATE', 'public', 'users')).toBe(false)
        expect(cdcPlugin.isEventMatch('INSERT', 'public', 'products')).toBe(
            false
        )
    })

    it('should return true for any event if broadcastAllEvents is enabled', () => {
        cdcPlugin.broadcastAllEvents = true
        expect(cdcPlugin.isEventMatch('INSERT', 'any', 'table')).toBe(true)
    })
})

describe('ChangeDataCapturePlugin - extractValuesFromQuery', () => {
    it('should extract values from INSERT queries', () => {
        const ast = parser.astify(
            `INSERT INTO users (id, name) VALUES (1, 'Alice')`
        )
        const extracted = cdcPlugin.extractValuesFromQuery(ast, [])
        expect(extracted).toEqual({ id: 1, name: 'Alice' })
    })

    it('should extract values from UPDATE queries', () => {
        const ast = parser.astify(`UPDATE users SET name = 'Bob' WHERE id = 2`)
        const extracted = cdcPlugin.extractValuesFromQuery(ast, [])
        expect(extracted).toEqual({ name: 'Bob', id: 2 })
    })

    it('should extract values from DELETE queries', () => {
        const ast = parser.astify(`DELETE FROM users WHERE id = 3`)
        const extracted = cdcPlugin.extractValuesFromQuery(ast, [])
        expect(extracted).toEqual({ id: 3 })
    })

    it('should use result data when available', () => {
        const result = { id: 4, name: 'Charlie' }
        const extracted = cdcPlugin.extractValuesFromQuery({}, result)
        expect(extracted).toEqual(result)
    })
})

describe('ChangeDataCapturePlugin - queryEventDetected', () => {
    it('should not trigger CDC event for unmatched actions', () => {
        const mockCallback = vi.fn()
        cdcPlugin.onEvent(mockCallback)

        const ast = parser.astify(`UPDATE users SET name = 'Emma' WHERE id = 6`)
        cdcPlugin.queryEventDetected('UPDATE', ast, [])

        expect(mockCallback).not.toHaveBeenCalled()
    })

    it('should broadcast matching events to callbacks and the durable object', () => {
        cdcPlugin.listeningEvents = [
            { action: 'INSERT', schema: 'main', table: 'users' },
        ]
        const mockCallback = vi.fn()
        cdcPlugin.onEvent(mockCallback)

        const ast = parser.astify(
            `INSERT INTO users (id, name) VALUES (8, 'Frank')`
        )

        cdcPlugin.queryEventDetected('INSERT', ast, [], 'session-123')

        const payload = {
            action: 'INSERT',
            schema: 'main',
            table: 'users',
            data: { id: 8, name: 'Frank' },
        }

        expect(mockCallback).toHaveBeenCalledWith(payload)
        expect(mockDurableObjectStub.fetch).toHaveBeenCalledOnce()

        const request = vi.mocked(mockDurableObjectStub.fetch).mock
            .calls[0][0] as Request
        expect(request.url).toBe(
            'https://example.com/socket/broadcast?sessionId=session-123'
        )
        expect(request.method).toBe('POST')
    })

    it('continues broadcasting when a callback throws', () => {
        cdcPlugin.listeningEvents = [
            { action: 'DELETE', schema: 'main', table: 'orders' },
        ]
        const brokenCallback = vi.fn(() => {
            throw new Error('callback failed')
        })
        const workingCallback = vi.fn()
        const consoleError = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})
        cdcPlugin['eventCallbacks'].push(brokenCallback, workingCallback)

        const ast = parser.astify(`DELETE FROM orders WHERE id = 99`)

        cdcPlugin.queryEventDetected('DELETE', ast, [])

        expect(brokenCallback).toHaveBeenCalledOnce()
        expect(workingCallback).toHaveBeenCalledWith({
            action: 'DELETE',
            schema: 'main',
            table: 'orders',
            data: { id: 99 },
        })
        expect(mockDurableObjectStub.fetch).toHaveBeenCalledOnce()
        expect(consoleError).toHaveBeenCalledWith(
            'Error in CDC event callback:',
            expect.any(Error)
        )

        consoleError.mockRestore()
    })
})

describe('ChangeDataCapturePlugin - onEvent', () => {
    it('should register event callbacks', () => {
        const mockCallback = vi.fn()
        cdcPlugin.onEvent(mockCallback)

        const registeredCallbacks = cdcPlugin['eventCallbacks']

        expect(registeredCallbacks).toHaveLength(1)
        expect(registeredCallbacks[0]).toBeInstanceOf(Function)
    })

    it('should call registered callbacks when event occurs', () => {
        const mockCallback = vi.fn()
        cdcPlugin.onEvent(mockCallback)

        const eventPayload = {
            action: 'INSERT',
            schema: 'public',
            table: 'users',
            data: { id: 8, name: 'Frank' },
        }

        cdcPlugin['eventCallbacks'].forEach((cb) => cb(eventPayload))

        expect(mockCallback).toHaveBeenCalledWith(eventPayload)
    })

    it('uses waitUntil for asynchronous callbacks when execution context is provided', () => {
        const asyncResult = Promise.resolve()
        const mockCallback = vi.fn(() => asyncResult)
        const waitUntil = vi.fn()

        cdcPlugin.onEvent(mockCallback, { waitUntil } as any)

        const payload = {
            action: 'INSERT',
            schema: 'public',
            table: 'users',
            data: { id: 10 },
        }
        cdcPlugin['eventCallbacks'][0](payload)

        expect(mockCallback).toHaveBeenCalledWith(payload)
        expect(waitUntil).toHaveBeenCalledWith(asyncResult)
    })
})

describe('ChangeDataCapturePlugin - afterQuery', () => {
    it('returns the original result when no events are configured', async () => {
        const plugin = new ChangeDataCapturePlugin({
            stub: mockDurableObjectStub,
            broadcastAllEvents: false,
            events: [],
        })
        const result = [{ id: 1 }]

        await expect(
            plugin.afterQuery({
                sql: `INSERT INTO users (id) VALUES (1)`,
                result,
                isRaw: false,
            })
        ).resolves.toBe(result)

        expect(mockDurableObjectStub.fetch).not.toHaveBeenCalled()
    })

    it('detects INSERT statements after removing RETURNING clauses', async () => {
        cdcPlugin.listeningEvents = [
            { action: 'INSERT', schema: 'main', table: 'users' },
        ]
        const mockCallback = vi.fn()
        cdcPlugin.onEvent(mockCallback)
        const result = [{ id: 12, name: 'Grace' }]

        await expect(
            cdcPlugin.afterQuery({
                sql: `INSERT INTO users (id, name) VALUES (12, 'Grace') RETURNING *`,
                result,
                isRaw: false,
            })
        ).resolves.toBe(result)

        expect(mockCallback).toHaveBeenCalledWith({
            action: 'INSERT',
            schema: 'main',
            table: 'users',
            data: result,
        })
        expect(mockDurableObjectStub.fetch).toHaveBeenCalledOnce()
    })

    it('logs parse errors and still returns the original result', async () => {
        const consoleError = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})
        const result = [{ ok: true }]

        await expect(
            cdcPlugin.afterQuery({
                sql: `not valid sql`,
                result,
                isRaw: false,
            })
        ).resolves.toBe(result)

        expect(consoleError).toHaveBeenCalledWith(
            'Error parsing SQL in CDC plugin:',
            'not valid sql',
            expect.any(Error)
        )
        expect(mockDurableObjectStub.fetch).not.toHaveBeenCalled()

        consoleError.mockRestore()
    })
})

describe('ChangeDataCapturePlugin - register', () => {
    it('rejects non-websocket requests to the CDC route', async () => {
        const app = new Hono()
        await cdcPlugin.register(app as any)

        const response = await app.request('/cdc')

        expect(response.status).toBe(400)
        await expect(response.text()).resolves.toBe('Expected upgrade request')
        expect(mockDurableObjectStub.fetch).not.toHaveBeenCalled()
    })

    it('rejects websocket subscriptions from non-admin users', async () => {
        const app = new Hono()
        app.use(async (c, next) => {
            const context = c as any
            context.set('config', { role: 'user' })
            await next()
        })
        await cdcPlugin.register(app as any)

        const response = await app.request('/cdc', {
            headers: { upgrade: 'websocket' },
        })

        expect(response.status).toBe(400)
        await expect(response.text()).resolves.toBe('Unauthorized request')
        expect(mockDurableObjectStub.fetch).not.toHaveBeenCalled()
    })

    it('forwards admin websocket subscriptions to the durable object', async () => {
        const randomUUID = vi
            .spyOn(crypto, 'randomUUID')
            .mockReturnValue('00000000-0000-4000-8000-000000000000')
        vi.mocked(mockDurableObjectStub.fetch).mockResolvedValue(
            new Response('upgraded', { status: 200 })
        )
        const app = new Hono()
        app.use(async (c, next) => {
            const context = c as any
            context.set('config', { role: 'admin' })
            await next()
        })
        await cdcPlugin.register(app as any)

        const response = await app.request('/cdc', {
            headers: { upgrade: 'websocket' },
        })

        expect(response.status).toBe(200)
        expect(mockDurableObjectStub.fetch).toHaveBeenCalledOnce()

        const request = vi.mocked(mockDurableObjectStub.fetch).mock
            .calls[0][0] as Request
        expect(request.url).toBe(
            'https://example.com/socket?sessionId=00000000-0000-4000-8000-000000000000'
        )
        expect(request.method).toBe('GET')

        randomUUID.mockRestore()
    })
})
