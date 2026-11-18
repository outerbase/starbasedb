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

    it('should get feature flag correctly', () => {
        expect(instance['getFeature']('rest')).toBe(true)
        expect(instance['getFeature']('export')).toBe(true)
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

    it('should return 400 if SQL query is invalid', async () => {
        const request = new Request('https://example.com/query', {
            method: 'POST',
            body: JSON.stringify({ sql: '' }),
            headers: { 'Content-Type': 'application/json' },
        })

        const response = await instance.queryRoute(request, false)

        expect(response.status).toBe(400)
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
})

describe('StarbaseDB Cache Expiry', () => {
    it('should remove expired cache entries', async () => {
        await instance['expireCache']()

        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: 'DELETE FROM tmp_cache WHERE timestamp + (ttl * 1000) < ?',
            params: [expect.any(Number)],
        })
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

    it('should throw if external source is configured without external details', () => {
        expect(
            () =>
                new StarbaseDB({
                    dataSource: { source: 'external', rpc: {} as any },
                    config: mockConfig,
                })
        ).toThrow('No external data sources available.')
    })

    it('should handle preAuth routes for authless plugins and return undefined otherwise', async () => {
        const pluginInstance = new StarbaseDB({
            dataSource: mockDataSource,
            config: mockConfig,
            plugins: [
                {
                    opts: { requiresAuth: false },
                    pathPrefix: '/public/:id/*',
                } as any,
            ],
        })

        const matched = await pluginInstance.handlePreAuth(
            new Request('https://example.com/public/123/view'),
            mockExecutionContext
        )
        expect(matched).toBeDefined()

        const unmatched = await pluginInstance.handlePreAuth(
            new Request('https://example.com/private/data'),
            mockExecutionContext
        )
        expect(unmatched).toBeUndefined()
    })

    it('should validate Content-Type, params, and transaction fields in queryRoute', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})

        const badContentType = new Request('https://example.com/query', {
            method: 'POST',
            body: JSON.stringify({ sql: 'SELECT 1' }),
            headers: { 'Content-Type': 'text/plain' },
        })
        expect((await instance.queryRoute(badContentType, false)).status).toBe(
            400
        )

        const badParams = new Request('https://example.com/query', {
            method: 'POST',
            body: JSON.stringify({ sql: 'SELECT 1', params: 'invalid' }),
            headers: { 'Content-Type': 'application/json' },
        })
        expect((await instance.queryRoute(badParams, false)).status).toBe(400)

        const badTxSql = new Request('https://example.com/query', {
            method: 'POST',
            body: JSON.stringify({ transaction: [{ sql: '' }] }),
            headers: { 'Content-Type': 'application/json' },
        })
        expect((await instance.queryRoute(badTxSql, false)).status).toBe(500)

        const badTxParams = new Request('https://example.com/query', {
            method: 'POST',
            body: JSON.stringify({
                transaction: [{ sql: 'SELECT 1', params: 123 }],
            }),
            headers: { 'Content-Type': 'application/json' },
        })
        expect((await instance.queryRoute(badTxParams, false)).status).toBe(500)
    })

    it('should log error if expireCache fails', async () => {
        const consoleSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})
        vi.mocked(mockDataSource.rpc.executeQuery).mockImplementationOnce(() => {
            throw new Error('Cache cleanup failed')
        })
        await instance['expireCache']()
        expect(consoleSpy).toHaveBeenCalled()
    })
})
