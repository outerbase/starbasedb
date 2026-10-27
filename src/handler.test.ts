import { describe, expect, it, vi, beforeEach } from 'vitest'
import { StarbaseDB } from './handler'
import type { DataSource } from './types'
import { executeQuery, executeTransaction } from './operation'
import { corsPreflight } from './cors'
import { StarbasePlugin } from './plugin'

vi.mock('./cors', () => ({
    corsPreflight: vi.fn().mockReturnValue(new Response(null, { status: 204 })),
    corsHeaders: { 'Access-Control-Allow-Origin': '*' },
}))

const mockExecutionContext = {
    waitUntil: vi.fn(),
} as unknown as ExecutionContext

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

vi.mock('./export/dump', () => ({
    dumpDatabaseRoute: vi
        .fn()
        .mockResolvedValue(new Response('mock-dump-export')),
}))
vi.mock('./export/json', () => ({
    exportTableToJsonRoute: vi
        .fn()
        .mockResolvedValue(new Response('mock-json-export')),
}))
vi.mock('./export/csv', () => ({
    exportTableToCsvRoute: vi
        .fn()
        .mockResolvedValue(new Response('mock-csv-export')),
}))
vi.mock('./import/dump', () => ({
    importDumpRoute: vi
        .fn()
        .mockResolvedValue(new Response('mock-dump-import')),
}))
vi.mock('./import/json', () => ({
    importTableFromJsonRoute: vi
        .fn()
        .mockResolvedValue(new Response('mock-json-import')),
}))
vi.mock('./import/csv', () => ({
    importTableFromCsvRoute: vi
        .fn()
        .mockResolvedValue(new Response('mock-csv-import')),
}))

let instance: StarbaseDB
let mockDataSource: DataSource
let mockConfig: any

class PublicWidgetPlugin extends StarbasePlugin {
    constructor() {
        super('public-widget', { requiresAuth: false }, '/widget/:id/*')
    }
    async register(app: any) {
        app.get('/widget/:id/*', (c: any) => c.text('widget-ok'))
    }
}

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
        plugins: [new PublicWidgetPlugin()],
    })

    vi.clearAllMocks()
})

describe('StarbaseDB Initialization', () => {
    it('should initialize with given data source and config', () => {
        expect(instance).toBeDefined()
        expect(instance['dataSource']).toBe(mockDataSource)
        expect(instance['config']).toBe(mockConfig)
    })

    it('should throw if source is external without external config', () => {
        expect(
            () =>
                new StarbaseDB({
                    dataSource: { source: 'external' } as any,
                    config: mockConfig,
                })
        ).toThrow('No external data sources available.')
    })

    it('should get feature flag correctly', () => {
        expect(instance['getFeature']('rest')).toBe(true)
        expect(instance['getFeature']('export')).toBe(true)
        expect(instance['getFeature']('allowlist', false)).toBe(false)
    })
})

describe('StarbaseDB Middleware, PreAuth & Routes', () => {
    it('should correctly handle CORS preflight', async () => {
        const request = new Request('https://example.com', {
            method: 'OPTIONS',
        })
        const response = await instance.handle(request, mockExecutionContext)

        expect(corsPreflight).toHaveBeenCalled()
        expect(response.status).toBe(204)
    })

    it('should serve authless plugin routes in handlePreAuth and return undefined for protected routes', async () => {
        const publicReq = new Request('https://example.com/widget/42/view')
        const preAuthRes = await instance.handlePreAuth(
            publicReq,
            mockExecutionContext
        )
        expect(preAuthRes).toBeDefined()
        expect(await preAuthRes!.text()).toBe('widget-ok')

        const privateReq = new Request('https://example.com/query')
        const noMatchRes = await instance.handlePreAuth(
            privateReq,
            mockExecutionContext
        )
        expect(noMatchRes).toBeUndefined()
    })

    it('should handle registered Hono routes (/query, /query/raw, /status/*, /rest/*, /export/*, /import/*, /api/*, 404)', async () => {
        // /query and /query/raw
        const qRes = await instance.handle(
            new Request('https://example.com/query', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sql: 'SELECT 1' }),
            }),
            mockExecutionContext
        )
        expect(qRes.status).toBe(200)

        const qRawRes = await instance.handle(
            new Request('https://example.com/query/raw', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sql: 'SELECT 1' }),
            }),
            mockExecutionContext
        )
        expect(qRawRes.status).toBe(200)

        // /status/database and /status/trace
        const statusDbRes = await instance.handle(
            new Request('https://example.com/status/database'),
            mockExecutionContext
        )
        expect(statusDbRes.status).toBe(200)

        const fetchSpy = vi
            .spyOn(global, 'fetch')
            .mockResolvedValueOnce(new Response('fl=1') as any)
        const traceRes = await instance.handle(
            new Request('https://example.com/status/trace'),
            mockExecutionContext
        )
        expect(traceRes.status).toBe(200)
        fetchSpy.mockRestore()

        // /rest/*
        const restRes = await instance.handle(
            new Request('https://example.com/rest/users'),
            mockExecutionContext
        )
        expect(await restRes.text()).toBe('mock-rest-response')

        // /export/*
        expect(
            await (
                await instance.handle(
                    new Request('https://example.com/export/dump'),
                    mockExecutionContext
                )
            ).text()
        ).toBe('mock-dump-export')
        expect(
            await (
                await instance.handle(
                    new Request('https://example.com/export/json/users'),
                    mockExecutionContext
                )
            ).text()
        ).toBe('mock-json-export')
        expect(
            await (
                await instance.handle(
                    new Request('https://example.com/export/csv/users'),
                    mockExecutionContext
                )
            ).text()
        ).toBe('mock-csv-export')

        // /import/*
        expect(
            await (
                await instance.handle(
                    new Request('https://example.com/import/dump', {
                        method: 'POST',
                    }),
                    mockExecutionContext
                )
            ).text()
        ).toBe('mock-dump-import')
        expect(
            await (
                await instance.handle(
                    new Request('https://example.com/import/json/users', {
                        method: 'POST',
                    }),
                    mockExecutionContext
                )
            ).text()
        ).toBe('mock-json-import')
        expect(
            await (
                await instance.handle(
                    new Request('https://example.com/import/csv/users', {
                        method: 'POST',
                    }),
                    mockExecutionContext
                )
            ).text()
        ).toBe('mock-csv-import')

        // /api/* and 404
        const apiRes = await instance.handle(
            new Request('https://example.com/api/your/path/here'),
            mockExecutionContext
        )
        expect(apiRes.status).toBe(200)

        const notFoundRes = await instance.handle(
            new Request('https://example.com/non-existent-route'),
            mockExecutionContext
        )
        expect(notFoundRes.status).toBe(404)

        // isInternalSource rejection when source !== 'internal'
        mockDataSource.source = 'hyperdrive'
        const extExportRes = await instance.handle(
            new Request('https://example.com/export/dump'),
            mockExecutionContext
        )
        expect(extExportRes.status).toBe(400)
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

    it('should return 400 if Content-Type is not application/json, SQL is invalid, or params are invalid', async () => {
        const badTypeRes = await instance.queryRoute(
            new Request('https://example.com/query', {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain' },
                body: 'SELECT 1',
            }),
            false
        )
        expect(badTypeRes.status).toBe(400)

        const badSqlRes = await instance.queryRoute(
            new Request('https://example.com/query', {
                method: 'POST',
                body: JSON.stringify({ sql: '' }),
                headers: { 'Content-Type': 'application/json' },
            }),
            false
        )
        expect(badSqlRes.status).toBe(400)

        const badParamsRes = await instance.queryRoute(
            new Request('https://example.com/query', {
                method: 'POST',
                body: JSON.stringify({ sql: 'SELECT 1', params: 'invalid' }),
                headers: { 'Content-Type': 'application/json' },
            }),
            false
        )
        expect(badParamsRes.status).toBe(400)
    })

    it('should execute a SQL transaction and validate transaction items', async () => {
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

        const consoleErrorSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})
        const badTxSqlRes = await instance.queryRoute(
            new Request('https://example.com/query', {
                method: 'POST',
                body: JSON.stringify({
                    transaction: [{ sql: '' }],
                }),
                headers: { 'Content-Type': 'application/json' },
            }),
            false
        )
        expect(badTxSqlRes.status).toBe(500)

        const badTxParamsRes = await instance.queryRoute(
            new Request('https://example.com/query', {
                method: 'POST',
                body: JSON.stringify({
                    transaction: [{ sql: 'SELECT 1', params: 'bad' }],
                }),
                headers: { 'Content-Type': 'application/json' },
            }),
            false
        )
        expect(badTxParamsRes.status).toBe(500)
        consoleErrorSpy.mockRestore()
    })
})

describe('StarbaseDB Cache Expiry & Error Handling', () => {
    it('should remove expired cache entries and catch errors', async () => {
        await instance['expireCache']()

        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: 'DELETE FROM tmp_cache WHERE timestamp + (ttl * 1000) < ?',
            params: [expect.any(Number)],
        })

        const consoleErrorSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})
        vi.mocked(mockDataSource.rpc.executeQuery).mockImplementationOnce(
            () => {
                throw new Error('Cache cleanup failed')
            }
        )
        await instance['expireCache']()
        expect(consoleErrorSpy).toHaveBeenCalled()
        consoleErrorSpy.mockRestore()
    })

    it('should return 500 if query execution fails', async () => {
        vi.mocked(executeQuery).mockRejectedValueOnce(
            new Error('Database error')
        )

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
        consoleErrorSpy.mockRestore()
    })
})
