import { describe, it, expect, vi, beforeEach } from 'vitest'
import { StarbaseDB } from './handler'
import { executeQuery, executeTransaction } from './operation'
import { LiteREST } from './literest'
import { corsPreflight } from './cors'
import { handleApiRequest } from './api'
import { dumpDatabaseRoute } from './export/dump'
import { exportTableToJsonRoute } from './export/json'
import { exportTableToCsvRoute } from './export/csv'
import { importDumpRoute } from './import/dump'
import { importTableFromJsonRoute } from './import/json'
import { importTableFromCsvRoute } from './import/csv'
import type { DataSource } from './types'

vi.mock('./utils', () => ({
    createResponse: vi.fn(
        (data, message, status) =>
            new Response(JSON.stringify({ result: data, error: message }), {
                status,
                headers: { 'Content-Type': 'application/json' },
            })
    ),
}))

vi.mock('./operation', () => ({
    executeQuery: vi.fn().mockResolvedValue([{ id: 1 }]),
    executeTransaction: vi.fn().mockResolvedValue([[{ id: 1 }]]),
}))

vi.mock('./literest', () => ({
    LiteREST: vi.fn().mockImplementation(() => ({
        handleRequest: vi.fn().mockResolvedValue(new Response('rest-result')),
    })),
}))

vi.mock('./cors', () => ({
    corsPreflight: vi.fn(),
}))

vi.mock('./api', () => ({
    handleApiRequest: vi
        .fn()
        .mockResolvedValue(new Response('api-result', { status: 200 })),
}))

vi.mock('./export/dump', () => ({
    dumpDatabaseRoute: vi
        .fn()
        .mockResolvedValue(new Response('dump-result', { status: 200 })),
}))

vi.mock('./export/json', () => ({
    exportTableToJsonRoute: vi
        .fn()
        .mockResolvedValue(new Response('json-result', { status: 200 })),
}))

vi.mock('./export/csv', () => ({
    exportTableToCsvRoute: vi
        .fn()
        .mockResolvedValue(new Response('csv-result', { status: 200 })),
}))

vi.mock('./import/dump', () => ({
    importDumpRoute: vi
        .fn()
        .mockResolvedValue(new Response('import-dump-result', { status: 200 })),
}))

vi.mock('./import/json', () => ({
    importTableFromJsonRoute: vi
        .fn()
        .mockResolvedValue(new Response('import-json-result', { status: 200 })),
}))

vi.mock('./import/csv', () => ({
    importTableFromCsvRoute: vi
        .fn()
        .mockResolvedValue(new Response('import-csv-result', { status: 200 })),
}))

let mockDataSource: DataSource

const ctx = {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
} as any

beforeEach(() => {
    vi.clearAllMocks()
    ;(corsPreflight as any).mockReturnValue(undefined)

    mockDataSource = {
        source: 'internal',
        rpc: { executeQuery: vi.fn().mockResolvedValue([{ id: 1 }]) },
    } as any
})

function createStarbase(overrides: any = {}) {
    return new StarbaseDB({
        dataSource: mockDataSource,
        config: {
            outerbaseApiKey: undefined,
            role: 'admin',
            features: {
                allowlist: false,
                rls: false,
                rest: true,
                export: true,
                import: true,
            },
        },
        plugins: [],
        ...overrides,
    })
}

function jsonResponse(response: Response): Promise<any> {
    return response.json() as any
}

describe('StarbaseDB handler - advanced behaviors', () => {
    it('rejects construction of an external source without connection details', () => {
        expect(
            () =>
                new StarbaseDB({
                    dataSource: { source: 'external' } as any,
                    config: { role: 'admin' },
                    plugins: [],
                })
        ).toThrow('No external data sources available.')
    })

    it('returns 404 for unknown routes', async () => {
        const starbase = createStarbase()
        const response = await starbase.handle(
            new Request('http://localhost/nope'),
            ctx
        )

        expect(response.status).toBe(404)
        expect((await jsonResponse(response)).error).toBe('Not found')
    })

    it('returns the cors preflight response for OPTIONS requests', async () => {
        const preflight = new Response(null, { status: 204 })
        ;(corsPreflight as any).mockReturnValue(preflight)

        const response = await createStarbase().handle(
            new Request('http://localhost/query', { method: 'OPTIONS' }),
            ctx
        )

        expect(response).toBe(preflight)
    })

    it('reports dialect information on /status/database', async () => {
        mockDataSource.external = { dialect: 'postgresql' } as any
        const response = await createStarbase().handle(
            new Request('http://localhost/status/database'),
            ctx
        )

        expect(response.status).toBe(200)
        const body = await jsonResponse(response)
        expect(body.result.dialects.external).toBe('postgresql')
        expect(body.result.dialects.hyperdrive).toBe('postgresql')
    })

    it('proxies the cloudflare trace endpoint', async () => {
        const traceResponse = new Response('trace-body', {
            headers: { 'x-trace': '1' },
        })
        const fetchSpy = vi.fn().mockResolvedValue(traceResponse)
        vi.stubGlobal('fetch', fetchSpy)

        const response = await createStarbase().handle(
            new Request('http://localhost/status/trace'),
            ctx
        )

        expect(fetchSpy).toHaveBeenCalledWith(
            'https://cloudflare.com/cdn-cgi/trace'
        )
        expect(await response.text()).toBe('trace-body')
        vi.unstubAllGlobals()
    })

    it('routes /rest/* requests to LiteREST when the feature is enabled', async () => {
        const response = await createStarbase().handle(
            new Request('http://localhost/rest/users'),
            ctx
        )

        expect(await response.text()).toBe('rest-result')
    })

    it('executes single queries posted to /query', async () => {
        const response = await createStarbase().handle(
            new Request('http://localhost/query', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sql: 'SELECT * FROM users' }),
            }),
            ctx
        )

        expect(response.status).toBe(200)
        expect(executeQuery).toHaveBeenCalledWith(
            expect.objectContaining({
                sql: 'SELECT * FROM users',
                isRaw: false,
            })
        )
    })

    it('passes isRaw for /query/raw requests', async () => {
        await createStarbase().handle(
            new Request('http://localhost/query/raw', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sql: 'SELECT * FROM users' }),
            }),
            ctx
        )

        expect(executeQuery).toHaveBeenCalledWith(
            expect.objectContaining({ isRaw: true })
        )
    })

    it('rejects non-json content types on the query route', async () => {
        const response = await createStarbase().handle(
            new Request('http://localhost/query', {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain' },
                body: 'plain',
            }),
            ctx
        )

        expect(response.status).toBe(400)
        expect((await jsonResponse(response)).error).toBe(
            'Content-Type must be application/json.'
        )
    })

    it('rejects empty sql fields on the query route', async () => {
        const response = await createStarbase().handle(
            new Request('http://localhost/query', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sql: '   ' }),
            }),
            ctx
        )

        expect(response.status).toBe(400)
        expect((await jsonResponse(response)).error).toBe(
            'Invalid or empty "sql" field.'
        )
    })

    it('rejects invalid params fields on the query route', async () => {
        const response = await createStarbase().handle(
            new Request('http://localhost/query', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sql: 'SELECT 1', params: 'bad' }),
            }),
            ctx
        )

        expect(response.status).toBe(400)
        expect((await jsonResponse(response)).error).toBe(
            'Invalid "params" field. Must be an array or object.'
        )
    })

    it('executes transactions when the transaction array is provided', async () => {
        const response = await createStarbase().handle(
            new Request('http://localhost/query', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    transaction: [
                        { sql: 'INSERT INTO users VALUES (1)' },
                        { sql: 'INSERT INTO users VALUES (2)', params: [2] },
                    ],
                }),
            }),
            ctx
        )

        expect(response.status).toBe(200)
        expect(executeTransaction).toHaveBeenCalledWith(
            expect.objectContaining({
                isRaw: false,
                queries: [
                    { sql: 'INSERT INTO users VALUES (1)', params: undefined },
                    { sql: 'INSERT INTO users VALUES (2)', params: [2] },
                ],
            })
        )
    })

    it('returns 500 when a transaction entry has an empty sql field', async () => {
        const response = await createStarbase().handle(
            new Request('http://localhost/query', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    transaction: [{ sql: '  ' }],
                }),
            }),
            ctx
        )

        expect(response.status).toBe(500)
        expect((await jsonResponse(response)).error).toBe(
            'Invalid or empty "sql" field in transaction.'
        )
    })

    it('returns 500 when a transaction entry has invalid params', async () => {
        const response = await createStarbase().handle(
            new Request('http://localhost/query', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    transaction: [{ sql: 'SELECT 1', params: 42 }],
                }),
            }),
            ctx
        )

        expect(response.status).toBe(500)
        expect((await jsonResponse(response)).error).toBe(
            'Invalid "params" field in transaction. Must be an array or object.'
        )
    })

    it('returns 500 through the error handler when query parsing fails', async () => {
        const response = await createStarbase().handle(
            new Request('http://localhost/query', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: 'not-json',
            }),
            ctx
        )

        expect(response.status).toBe(500)
    })

    it('returns 400 for export/import routes on non-internal sources', async () => {
        mockDataSource.source = 'external'
        mockDataSource.external = { dialect: 'postgresql' } as any
        const starbase = createStarbase()

        const response = await starbase.handle(
            new Request('http://localhost/export/dump'),
            ctx
        )

        expect(response.status).toBe(400)
        expect((await jsonResponse(response)).error).toBe(
            'Function is only available for internal data source.'
        )
    })

    it('serves the export dump route for internal sources', async () => {
        const response = await createStarbase().handle(
            new Request('http://localhost/export/dump'),
            ctx
        )

        expect(await response.text()).toBe('dump-result')
        expect(dumpDatabaseRoute).toHaveBeenCalled()
    })

    it('serves json and csv table exports', async () => {
        const starbase = createStarbase()

        const jsonResponse = await starbase.handle(
            new Request('http://localhost/export/json/users'),
            ctx
        )
        expect(await jsonResponse.text()).toBe('json-result')
        expect(exportTableToJsonRoute).toHaveBeenCalledWith(
            'users',
            mockDataSource,
            starbase['config']
        )

        const csvResponse = await starbase.handle(
            new Request('http://localhost/export/csv/users'),
            ctx
        )
        expect(await csvResponse.text()).toBe('csv-result')
        expect(exportTableToCsvRoute).toHaveBeenCalled()
    })

    it('requires a table name for export routes', async () => {
        const response = await createStarbase().handle(
            new Request('http://localhost/export/json/%20'),
            ctx
        )

        expect(response.status).toBe(400)
        expect((await jsonResponse(response)).error).toBe(
            'Table name is required'
        )
    })

    it('serves the import routes', async () => {
        const starbase = createStarbase()

        const dumpResponse = await starbase.handle(
            new Request('http://localhost/import/dump', { method: 'POST' }),
            ctx
        )
        expect(await dumpResponse.text()).toBe('import-dump-result')
        expect(importDumpRoute).toHaveBeenCalled()

        const jsonResponse = await starbase.handle(
            new Request('http://localhost/import/json/users', {
                method: 'POST',
            }),
            ctx
        )
        expect(await jsonResponse.text()).toBe('import-json-result')
        expect(importTableFromJsonRoute).toHaveBeenCalled()

        const csvResponse = await starbase.handle(
            new Request('http://localhost/import/csv/users', {
                method: 'POST',
            }),
            ctx
        )
        expect(await csvResponse.text()).toBe('import-csv-result')
        expect(importTableFromCsvRoute).toHaveBeenCalled()
    })

    it('routes /api/* requests to the api handler', async () => {
        const response = await createStarbase().handle(
            new Request('http://localhost/api/v1/thing'),
            ctx
        )

        expect(await response.text()).toBe('api-result')
        expect(handleApiRequest).toHaveBeenCalled()
    })

    it('schedules cache expiration via waitUntil on handle', async () => {
        await createStarbase().handle(
            new Request('http://localhost/query', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sql: 'SELECT 1' }),
            }),
            ctx
        )

        expect(ctx.waitUntil).toHaveBeenCalled()
        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledWith(
            expect.objectContaining({
                sql: expect.stringContaining('tmp_cache'),
            })
        )
    })

    it('handlePreAuth serves authless plugin routes directly', async () => {
        const authlessPlugin = {
            name: 'public-plugin',
            opts: { requiresAuth: false },
            pathPrefix: '/public/*',
            register: vi.fn().mockResolvedValue(undefined),
        }

        const starbase = createStarbase({ plugins: [authlessPlugin as any] })
        const response = await starbase.handlePreAuth(
            new Request('http://localhost/public/page'),
            ctx
        )

        expect(response).toBeDefined()
        expect(response!.status).toBe(404)
    })

    it('handlePreAuth returns undefined for authenticated plugin routes', async () => {
        const authPlugin = {
            name: 'auth-plugin',
            opts: { requiresAuth: true },
            pathPrefix: '/private/*',
            register: vi.fn().mockResolvedValue(undefined),
        }

        const starbase = createStarbase({ plugins: [authPlugin as any] })
        const result = await starbase.handlePreAuth(
            new Request('http://localhost/private/page'),
            ctx
        )

        expect(result).toBeUndefined()
    })

    it('handlePreAuth ignores authless plugins without a pathPrefix', async () => {
        const noPrefixPlugin = {
            name: 'no-prefix',
            opts: { requiresAuth: false },
            register: vi.fn().mockResolvedValue(undefined),
        }

        const starbase = createStarbase({ plugins: [noPrefixPlugin as any] })
        const result = await starbase.handlePreAuth(
            new Request('http://localhost/anything'),
            ctx
        )

        expect(result).toBeUndefined()
    })
})
