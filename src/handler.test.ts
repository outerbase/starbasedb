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
    it('should reject query requests without JSON content type', async () => {
        const request = new Request('https://example.com/query', {
            method: 'POST',
            body: 'SELECT * FROM users',
            headers: { 'Content-Type': 'text/plain' },
        })

        const response = await instance.queryRoute(request, false)

        expect(createResponse).toHaveBeenCalledWith(
            undefined,
            'Content-Type must be application/json.',
            400
        )
        expect(response.status).toBe(400)
        expect(executeQuery).not.toHaveBeenCalled()
    })

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

    it('should reject invalid query params', async () => {
        const request = new Request('https://example.com/query', {
            method: 'POST',
            body: JSON.stringify({
                sql: 'SELECT * FROM users WHERE id = ?',
                params: '1',
            }),
            headers: { 'Content-Type': 'application/json' },
        })

        const response = await instance.queryRoute(request, false)

        expect(createResponse).toHaveBeenCalledWith(
            undefined,
            'Invalid "params" field. Must be an array or object.',
            400
        )
        expect(response.status).toBe(400)
        expect(executeQuery).not.toHaveBeenCalled()
    })

    it('should execute a SQL transaction', async () => {
        const request = new Request('https://example.com/query', {
            method: 'POST',
            body: JSON.stringify({
                transaction: [
                    {
                        sql: "INSERT INTO users VALUES (?, 'Alice')",
                        params: [1],
                    },
                ],
            }),
            headers: { 'Content-Type': 'application/json' },
        })

        const response = await instance.queryRoute(request, true)

        expect(executeTransaction).toHaveBeenCalledWith({
            queries: [
                {
                    sql: "INSERT INTO users VALUES (?, 'Alice')",
                    params: [1],
                },
            ],
            isRaw: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })
        expect(response.status).toBe(200)
    })

    it('should reject transactions with an empty SQL statement', async () => {
        const request = new Request('https://example.com/query', {
            method: 'POST',
            body: JSON.stringify({
                transaction: [{ sql: '   ' }],
            }),
            headers: { 'Content-Type': 'application/json' },
        })

        const response = await instance.queryRoute(request, false)

        expect(createResponse).toHaveBeenCalledWith(
            undefined,
            'Invalid or empty "sql" field in transaction.',
            400
        )
        expect(response.status).toBe(400)
        expect(executeTransaction).not.toHaveBeenCalled()
    })

    it('should reject transactions with invalid params', async () => {
        const request = new Request('https://example.com/query', {
            method: 'POST',
            body: JSON.stringify({
                transaction: [{ sql: 'SELECT * FROM users', params: 'bad' }],
            }),
            headers: { 'Content-Type': 'application/json' },
        })

        const response = await instance.queryRoute(request, false)

        expect(createResponse).toHaveBeenCalledWith(
            undefined,
            'Invalid "params" field in transaction. Must be an array or object.',
            400
        )
        expect(response.status).toBe(400)
        expect(executeTransaction).not.toHaveBeenCalled()
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
})
