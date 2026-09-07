import { beforeEach, describe, expect, it, vi } from 'vitest'
import { StarbaseDB } from './handler'
import { executeQuery, executeTransaction } from './operation'
import { dumpDatabaseRoute } from './export/dump'
import { exportTableToJsonRoute } from './export/json'
import { exportTableToCsvRoute } from './export/csv'
import { importDumpRoute } from './import/dump'
import { importTableFromJsonRoute } from './import/json'
import { importTableFromCsvRoute } from './import/csv'
import { handleApiRequest } from './api'
import { LiteREST } from './literest'
import type { DataSource } from './types'

vi.mock('./operation', () => ({
    executeQuery: vi.fn().mockResolvedValue([{ ok: true }]),
    executeTransaction: vi.fn().mockResolvedValue([{ ok: true }]),
}))

vi.mock('./export/dump', () => ({
    dumpDatabaseRoute: vi.fn().mockResolvedValue(new Response('dump')),
}))

vi.mock('./export/json', () => ({
    exportTableToJsonRoute: vi
        .fn()
        .mockResolvedValue(new Response('{"users":[]}')),
}))

vi.mock('./export/csv', () => ({
    exportTableToCsvRoute: vi.fn().mockResolvedValue(new Response('id,name')),
}))

vi.mock('./import/dump', () => ({
    importDumpRoute: vi.fn().mockResolvedValue(new Response('imported-dump')),
}))

vi.mock('./import/json', () => ({
    importTableFromJsonRoute: vi
        .fn()
        .mockResolvedValue(new Response('imported-json')),
}))

vi.mock('./import/csv', () => ({
    importTableFromCsvRoute: vi
        .fn()
        .mockResolvedValue(new Response('imported-csv')),
}))

vi.mock('./api', () => ({
    handleApiRequest: vi.fn().mockResolvedValue(new Response('api')),
}))

vi.mock('./literest', () => ({
    LiteREST: vi.fn().mockImplementation(() => ({
        handleRequest: vi.fn().mockResolvedValue(new Response('rest')),
    })),
}))

const ctx = { waitUntil: vi.fn() } as unknown as ExecutionContext

function createInstance(
    overrides: {
        source?: DataSource['source']
        features?: Record<string, boolean>
        plugins?: any[]
    } = {}
) {
    const dataSource = {
        source: overrides.source ?? 'internal',
        external:
            overrides.source === 'external' ? { dialect: 'sqlite' } : undefined,
        rpc: {
            executeQuery: vi.fn().mockResolvedValue([]),
        },
    } as any

    return new StarbaseDB({
        dataSource,
        config: {
            role: 'admin',
            features: {
                rest: true,
                export: true,
                import: true,
                ...overrides.features,
            },
        },
        plugins: overrides.plugins,
    })
}

beforeEach(() => {
    vi.clearAllMocks()
})

describe('StarbaseDB HTTP routes', () => {
    it('throws when an external source is missing connection details', () => {
        expect(
            () =>
                new StarbaseDB({
                    dataSource: { source: 'external', rpc: {} } as any,
                    config: { role: 'admin' },
                })
        ).toThrow('No external data sources available.')
    })

    it('returns dialect status for the current data source', async () => {
        const instance = createInstance({ source: 'external' })
        const response = await instance.handle(
            new Request('https://example.com/status/database'),
            ctx
        )

        expect(response.status).toBe(200)
        const body = (await response.json()) as {
            result: { dialects: { external?: string; hyperdrive: string } }
        }
        expect(body.result.dialects.external).toBe('sqlite')
        expect(body.result.dialects.hyperdrive).toBe('postgresql')
    })

    it('executes a single query through the /query route', async () => {
        const instance = createInstance()
        const response = await instance.handle(
            new Request('https://example.com/query', {
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

    it('executes a raw transaction through /query/raw', async () => {
        const instance = createInstance()
        const response = await instance.handle(
            new Request('https://example.com/query/raw', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    transaction: [
                        {
                            sql: 'INSERT INTO users (name) VALUES (?)',
                            params: ['Ada'],
                        },
                    ],
                }),
            }),
            ctx
        )

        expect(response.status).toBe(200)
        expect(executeTransaction).toHaveBeenCalledWith(
            expect.objectContaining({ isRaw: true })
        )
    })

    it('rejects /query requests without JSON content type', async () => {
        const instance = createInstance()
        const response = await instance.handle(
            new Request('https://example.com/query', {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain' },
                body: 'SELECT 1',
            }),
            ctx
        )

        expect(response.status).toBe(400)
        const body = (await response.json()) as { error?: string }
        expect(body.error).toBe('Content-Type must be application/json.')
    })

    it('rejects invalid query params and empty SQL', async () => {
        const instance = createInstance()

        const invalidParams = await instance.handle(
            new Request('https://example.com/query', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sql: 'SELECT 1', params: 'nope' }),
            }),
            ctx
        )
        expect(invalidParams.status).toBe(400)

        const emptySql = await instance.handle(
            new Request('https://example.com/query', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sql: '   ' }),
            }),
            ctx
        )
        expect(emptySql.status).toBe(400)
    })

    it('rejects invalid transaction entries', async () => {
        const instance = createInstance()
        const response = await instance.handle(
            new Request('https://example.com/query', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    transaction: [{ sql: '', params: [] }],
                }),
            }),
            ctx
        )

        expect(response.status).toBe(500)
        const body = (await response.json()) as { error?: string }
        expect(body.error).toContain('Invalid or empty "sql" field')
    })

    it('rejects transaction params that are neither an array nor an object', async () => {
        const instance = createInstance()
        const response = await instance.handle(
            new Request('https://example.com/query', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    transaction: [{ sql: 'SELECT 1', params: -1 }],
                }),
            }),
            ctx
        )

        expect(response.status).toBe(500)
        const body = (await response.json()) as { error?: string }
        expect(body.error).toContain('Invalid "params" field')
    })

    it('routes REST, export, import, and API requests', async () => {
        const instance = createInstance()

        const rest = await instance.handle(
            new Request('https://example.com/rest/main/users'),
            ctx
        )
        expect(await rest.text()).toBe('rest')

        const dump = await instance.handle(
            new Request('https://example.com/export/dump'),
            ctx
        )
        expect(dumpDatabaseRoute).toHaveBeenCalled()
        expect(await dump.text()).toBe('dump')

        await instance.handle(
            new Request('https://example.com/export/json/users'),
            ctx
        )
        expect(exportTableToJsonRoute).toHaveBeenCalledWith(
            'users',
            expect.anything(),
            expect.anything()
        )

        await instance.handle(
            new Request('https://example.com/export/csv/users'),
            ctx
        )
        expect(exportTableToCsvRoute).toHaveBeenCalled()

        await instance.handle(
            new Request('https://example.com/import/dump', { method: 'POST' }),
            ctx
        )
        expect(importDumpRoute).toHaveBeenCalled()

        await instance.handle(
            new Request('https://example.com/import/json/users', {
                method: 'POST',
            }),
            ctx
        )
        expect(importTableFromJsonRoute).toHaveBeenCalled()

        await instance.handle(
            new Request('https://example.com/import/csv/users', {
                method: 'POST',
            }),
            ctx
        )
        expect(importTableFromCsvRoute).toHaveBeenCalled()

        const api = await instance.handle(
            new Request('https://example.com/api/status'),
            ctx
        )
        expect(handleApiRequest).toHaveBeenCalled()
        expect(await api.text()).toBe('api')
    })

    it('blocks export/import helpers for non-internal sources', async () => {
        const instance = createInstance({ source: 'external' })
        const response = await instance.handle(
            new Request('https://example.com/export/dump'),
            ctx
        )

        expect(response.status).toBe(400)
        const body = (await response.json()) as { error?: string }
        expect(body.error).toBe(
            'Function is only available for internal data source.'
        )
        expect(dumpDatabaseRoute).not.toHaveBeenCalled()
    })

    it('does not register REST or import routes when those features are off', async () => {
        const instance = createInstance({
            features: { rest: false, export: false, import: false },
        })

        const rest = await instance.handle(
            new Request('https://example.com/rest/main/users'),
            ctx
        )
        expect(rest.status).toBe(404)

        const dump = await instance.handle(
            new Request('https://example.com/export/dump'),
            ctx
        )
        expect(dump.status).toBe(404)
        expect(dumpDatabaseRoute).not.toHaveBeenCalled()
    })

    it('returns CORS preflight from handle() and expires cache in the background', async () => {
        const instance = createInstance()
        const response = await instance.handle(
            new Request('https://example.com/query', { method: 'OPTIONS' }),
            ctx
        )

        expect(response.status).toBe(204)
        expect(ctx.waitUntil).toHaveBeenCalled()
    })

    it('serves authless plugins before authentication', async () => {
        const plugin = {
            name: 'studio',
            opts: { requiresAuth: false },
            pathPrefix: '/studio',
            register: vi.fn(async (app) => {
                app.get('/studio', () => new Response('studio-ui'))
            }),
            beforeQuery: async (opts: any) => opts,
            afterQuery: async (opts: any) => opts.result,
        }
        const instance = createInstance({ plugins: [plugin] })

        const matched = await instance.handlePreAuth(
            new Request('https://example.com/studio'),
            ctx
        )
        expect(matched).toBeInstanceOf(Response)
        expect(await matched!.text()).toBe('studio-ui')

        const unmatched = await instance.handlePreAuth(
            new Request('https://example.com/query'),
            ctx
        )
        expect(unmatched).toBeUndefined()
    })

    it('matches parameterized authless plugin prefixes', async () => {
        const plugin = {
            name: 'webhook',
            opts: { requiresAuth: false },
            pathPrefix: '/hooks/:id',
            register: vi.fn(async (app) => {
                app.get(
                    '/hooks/:id',
                    (c: any) => new Response(c.req.param('id'))
                )
            }),
            beforeQuery: async (opts: any) => opts,
            afterQuery: async (opts: any) => opts.result,
        }
        const instance = createInstance({ plugins: [plugin] })

        const response = await instance.handlePreAuth(
            new Request('https://example.com/hooks/abc'),
            ctx
        )

        expect(await response!.text()).toBe('abc')
    })

    it('returns 404 for unknown paths and 500 from the Hono error handler', async () => {
        vi.mocked(executeQuery).mockRejectedValueOnce(new Error('boom'))
        const instance = createInstance()

        const missing = await instance.handle(
            new Request('https://example.com/does-not-exist'),
            ctx
        )
        expect(missing.status).toBe(404)

        const failed = await instance.handle(
            new Request('https://example.com/query', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ sql: 'SELECT 1' }),
            }),
            ctx
        )
        // queryRoute catches the error itself and returns 500
        expect(failed.status).toBe(500)
    })

    it('swallows expire-cache errors', async () => {
        const instance = createInstance()
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        vi.mocked(instance['dataSource'].rpc.executeQuery).mockImplementation(
            () => {
                throw new Error('cache table missing')
            }
        )

        await expect(instance['expireCache']()).resolves.toBeUndefined()
        expect(errorSpy).toHaveBeenCalled()
    })

    it('initializes only once', async () => {
        const instance = createInstance()
        await instance.handle(
            new Request('https://example.com/status/database'),
            ctx
        )
        await instance.handle(
            new Request('https://example.com/status/database'),
            ctx
        )

        expect(LiteREST).toHaveBeenCalledTimes(1)
    })
})
