import { describe, expect, it, vi, beforeEach } from 'vitest'
import { StarbaseDB } from './handler'
import type { DataSource } from './types'
import { Hono } from 'hono'
import { executeQuery, executeTransaction } from './operation'
import { LiteREST } from './literest'
import { createResponse } from './utils'
import { corsPreflight } from './cors'
import { StarbasePluginRegistry } from './plugin'

vi.mock('./cors', () => ({
    corsPreflight: vi.fn().mockReturnValue(new Response(null, { status: 204 })),
}))

const mockExecutionContext = {
    waitUntil: vi.fn(),
} as unknown as ExecutionContext

vi.mock('hono', () => {
    return {
        Hono: vi.fn().mockImplementation(() => ({
            use: vi.fn(),
            post: vi.fn(),
            get: vi.fn(),
            all: vi.fn(),
            fetch: vi.fn().mockResolvedValue(new Response('mock-response')),
            notFound: vi.fn(),
            onError: vi.fn(),
        })),
    }
})

vi.mock('./operation', () => ({
    executeQuery: vi.fn().mockResolvedValue('mock-query-result'),
    executeTransaction: vi.fn().mockResolvedValue('mock-transaction-result'),
}))

vi.mock('./literest', () => ({
    LiteREST: vi.fn().mockImplementation(() => ({
        handleRequest: vi
            .fn()
            .mockResolvedValue(new Response('mock-rest-response')),
    })),
}))

vi.mock('./plugin', () => ({
    StarbasePluginRegistry: vi.fn().mockImplementation(() => ({
        init: vi.fn(),
    })),
}))

vi.mock('./utils', () => ({
    createResponse: vi.fn((result, error, status) => ({
        result,
        error,
        status,
    })),
}))

let instance: StarbaseDB
let mockDataSource: DataSource
let mockConfig: any

beforeEach(() => {
    mockConfig = {
        role: 'admin' as 'admin' | 'client',
        features: { rest: true, export: true, import: true },
    }

    const mockExecuteQuery = vi.fn().mockResolvedValue([
        { id: 1, name: 'Alice' },
        { id: 2, name: 'Bob' },
    ]) as unknown as DataSource['rpc']['executeQuery']

    ;(mockExecuteQuery as any)[Symbol.dispose] = vi.fn()

    mockDataSource = {
        source: 'internal',
        rpc: {
            executeQuery: mockExecuteQuery,
        } as any,
    }

    instance = new StarbaseDB({
        dataSource: mockDataSource,
        config: mockConfig,
    })

    vi.clearAllMocks()
})

describe('StarbaseDB Initialization', () => {
    it('should initialize with given data source and config', () => {
        expect(instance).toBeDefined()
        expect(instance['dataSource']).toBe(mockDataSource)
        expect(instance['config']).toBe(mockConfig)
    })

    it('should throw error when source is external but external config is missing', () => {
        expect(
            () =>
                new StarbaseDB({
                    dataSource: { source: 'external' } as any,
                    config: mockConfig,
                })
        ).toThrow('No external data sources available.')
    })

    it('should get feature flag correctly with default and config values', () => {
        expect(instance['getFeature']('rest')).toBe(true)
        expect(instance['getFeature']('export')).toBe(true)

        const noFeaturesInstance = new StarbaseDB({
            dataSource: mockDataSource,
            config: { role: 'admin' },
        })
        expect(noFeaturesInstance['getFeature']('rest', true)).toBe(true)
        expect(noFeaturesInstance['getFeature']('rest', false)).toBe(false)

        const disabledFeaturesInstance = new StarbaseDB({
            dataSource: mockDataSource,
            config: {
                role: 'admin',
                features: { rest: false, export: false, import: false },
            },
        })
        expect(disabledFeaturesInstance['getFeature']('rest')).toBe(false)
        expect(disabledFeaturesInstance['getFeature']('export')).toBe(false)
        expect(disabledFeaturesInstance['getFeature']('import')).toBe(false)
    })
})

describe('StarbaseDB Middleware & Request Handling', () => {
    it('should correctly handle CORS preflight', async () => {
        const request = new Request('https://example.com', {
            method: 'OPTIONS',
        })
        const response = await instance.handle(request, mockExecutionContext)

        expect(corsPreflight).toHaveBeenCalled()
        expect(response.status).toBe(204)
    })

    it('should fetch using Hono app', async () => {
        const request = new Request('https://example.com/api/test')
        const response = await instance.handle(request, mockExecutionContext)

        expect(instance['app'].fetch).toHaveBeenCalledWith(request)
        expect(response).toBeDefined()
    })

    it('should not reinitialize if already initialized', async () => {
        const request = new Request('https://example.com/api/test')
        await instance.handle(request, mockExecutionContext)
        await instance.handle(request, mockExecutionContext)

        expect(instance['initialized']).toBe(true)
    })

    it('should handle preAuth matching an authless plugin pathPrefix', async () => {
        const mockPlugin = {
            name: 'test-authless-plugin',
            opts: { requiresAuth: false },
            pathPrefix: '/public/*',
            register: vi.fn(),
        }
        const instWithPlugin = new StarbaseDB({
            dataSource: mockDataSource,
            config: mockConfig,
            plugins: [mockPlugin as any],
        })

        const req = new Request('https://example.com/public/dashboard')
        const res = await instWithPlugin.handlePreAuth(req, mockExecutionContext)

        expect(res).toBeDefined()
    })

    it('should handle preAuth with parameterized plugin pathPrefix', async () => {
        const mockPlugin = {
            name: 'param-plugin',
            opts: { requiresAuth: false },
            pathPrefix: '/user/:id/profile',
            register: vi.fn(),
        }
        const instWithPlugin = new StarbaseDB({
            dataSource: mockDataSource,
            config: mockConfig,
            plugins: [mockPlugin as any],
        })

        const req = new Request('https://example.com/user/123/profile')
        const res = await instWithPlugin.handlePreAuth(req, mockExecutionContext)

        expect(res).toBeDefined()
    })

    it('should return undefined in preAuth if route does not match authless plugin', async () => {
        const mockPlugin = {
            name: 'test-plugin',
            opts: { requiresAuth: false },
            pathPrefix: '/public/*',
            register: vi.fn(),
        }
        const instWithPlugin = new StarbaseDB({
            dataSource: mockDataSource,
            config: mockConfig,
            plugins: [mockPlugin as any],
        })

        const req = new Request('https://example.com/private/settings')
        const res = await instWithPlugin.handlePreAuth(req, mockExecutionContext)

        expect(res).toBeUndefined()
    })

    it('should return undefined in preAuth for plugins that require auth', async () => {
        const mockPlugin = {
            name: 'auth-required-plugin',
            opts: { requiresAuth: true },
            pathPrefix: '/secure/*',
            register: vi.fn(),
        }
        const instWithPlugin = new StarbaseDB({
            dataSource: mockDataSource,
            config: mockConfig,
            plugins: [mockPlugin as any],
        })

        const req = new Request('https://example.com/secure/data')
        const res = await instWithPlugin.handlePreAuth(req, mockExecutionContext)

        expect(res).toBeUndefined()
    })
})

describe('StarbaseDB Query Execution', () => {
    it('should execute a valid SQL query', async () => {
        const request = new Request('https://example.com/query', {
            method: 'POST',
            body: JSON.stringify({ sql: 'SELECT * FROM users' }),
            headers: { 'Content-Type': 'application/json' },
        })

        const response = await instance.queryRoute(request, false)

        expect(executeQuery).toHaveBeenCalledWith({
            sql: 'SELECT * FROM users',
            params: undefined,
            isRaw: false,
            dataSource: mockDataSource,
            config: mockConfig,
        })
        expect(response.status).toBe(200)
    })

    it('should return 400 if Content-Type is not application/json', async () => {
        const request = new Request('https://example.com/query', {
            method: 'POST',
            body: 'plain text',
            headers: { 'Content-Type': 'text/plain' },
        })

        const response = await instance.queryRoute(request, false)

        expect(response.status).toBe(400)
        expect(response.error).toBe('Content-Type must be application/json.')
    })

    it('should return 400 if SQL query is invalid or empty', async () => {
        const request = new Request('https://example.com/query', {
            method: 'POST',
            body: JSON.stringify({ sql: '' }),
            headers: { 'Content-Type': 'application/json' },
        })

        const response = await instance.queryRoute(request, false)

        expect(response.status).toBe(400)
        expect(response.error).toBe('Invalid or empty "sql" field.')
    })

    it('should return 400 if params is invalid', async () => {
        const request = new Request('https://example.com/query', {
            method: 'POST',
            body: JSON.stringify({ sql: 'SELECT 1', params: 12345 }),
            headers: { 'Content-Type': 'application/json' },
        })

        const response = await instance.queryRoute(request, false)

        expect(response.status).toBe(400)
        expect(response.error).toBe(
            'Invalid "params" field. Must be an array or object.'
        )
    })

    it('should execute a SQL transaction', async () => {
        const request = new Request('https://example.com/query', {
            method: 'POST',
            body: JSON.stringify({
                transaction: [{ sql: "INSERT INTO users VALUES (1, 'Alice')" }],
            }),
            headers: { 'Content-Type': 'application/json' },
        })

        const response = await instance.queryRoute(request, false)

        expect(executeTransaction).toHaveBeenCalled()
        expect(response.status).toBe(200)
    })

    it('should return 500 if a query in transaction has empty sql', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        const request = new Request('https://example.com/query', {
            method: 'POST',
            body: JSON.stringify({
                transaction: [{ sql: '   ' }],
            }),
            headers: { 'Content-Type': 'application/json' },
        })

        const response = await instance.queryRoute(request, false)

        expect(response.status).toBe(500)
        expect(response.error).toBe(
            'Invalid or empty "sql" field in transaction.'
        )
    })

    it('should return 500 if a query in transaction has invalid params', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        const request = new Request('https://example.com/query', {
            method: 'POST',
            body: JSON.stringify({
                transaction: [{ sql: 'INSERT INTO tbl VALUES (?)', params: 999 }],
            }),
            headers: { 'Content-Type': 'application/json' },
        })

        const response = await instance.queryRoute(request, false)

        expect(response.status).toBe(500)
        expect(response.error).toBe(
            'Invalid "params" field in transaction. Must be an array or object.'
        )
    })
})

describe('StarbaseDB Cache Expiry', () => {
    it('should remove expired cache entries', async () => {
        await instance['expireCache']()

        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: 'DELETE FROM tmp_cache WHERE timestamp + (ttl * 1000) < ?',
            params: [expect.any(Number)],
        })
    })

    it('should catch and log error if cache expiry fails', async () => {
        mockDataSource.rpc.executeQuery = vi.fn().mockImplementationOnce(() => {
            throw new Error('Cache cleanup failure')
        })
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

        await instance['expireCache']()

        expect(consoleErrorSpy).toHaveBeenCalledWith(
            'Error cleaning up expired cache entries:',
            expect.any(Error)
        )
    })
})

describe('StarbaseDB Error Handling', () => {
    it('should return 500 if query execution fails', async () => {
        vi.mocked(executeQuery).mockRejectedValue(new Error('Database error'))

        const request = new Request('https://example.com/query', {
            method: 'POST',
            body: JSON.stringify({ sql: 'INVALID SQL' }),
            headers: { 'Content-Type': 'application/json' },
        })

        const consoleErrorSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})

        const response = await instance.queryRoute(request, false)

        expect(response.status).toBe(500)
    })
})
