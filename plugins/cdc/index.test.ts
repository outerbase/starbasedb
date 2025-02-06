import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ChangeDataCapturePlugin } from './index'
import { StarbaseDBConfiguration } from '../../src/handler'
import { DataSource } from '../../src/types'
import type { DurableObjectStub } from '@cloudflare/workers-types'

const parser = new (require('node-sql-parser').Parser)()

let cdcPlugin: ChangeDataCapturePlugin
let mockDurableObjectStub: DurableObjectStub<any>
let mockConfig: StarbaseDBConfiguration

beforeEach(() => {
    vi.clearAllMocks()
    mockDurableObjectStub = {
        fetch: vi.fn().mockResolvedValue(new Response('OK', { status: 200 })),
    } as unknown as DurableObjectStub

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
    } as any

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
})
