import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
    executeQuery,
    executeExternalQuery,
    executeSDKQuery,
    executeTransaction,
} from './operation'
import { applyRLS } from './rls'
import { beforeQueryCache, afterQueryCache } from './cache'
import { Client as PgClient } from 'pg'
import { createConnection } from 'mysql2'
import { createClient } from '@libsql/client/web'
import postgres from 'postgres'
import {
    PostgreSQLConnection,
    MySQLConnection,
    TursoConnection,
    CloudflareD1Connection,
    StarbaseConnection,
} from '@outerbase/sdk'
vi.mock('pg', () => ({ Client: vi.fn() }))
vi.mock('mysql2', () => ({ createConnection: vi.fn() }))
vi.mock('@libsql/client/web', () => ({ createClient: vi.fn() }))
vi.mock('postgres', () => ({ default: vi.fn() }))
vi.mock('@outerbase/sdk', () => ({
    PostgreSQLConnection: vi.fn(),
    MySQLConnection: vi.fn(),
    TursoConnection: vi.fn(),
    CloudflareD1Connection: vi.fn(),
    StarbaseConnection: vi.fn(),
}))
const drivers = {
    connect: vi.fn(),
    raw: vi.fn(),
    unsafe: vi.fn(),
    end: vi.fn(),
    pg: vi.mocked(PgClient),
    mysql: vi.mocked(createConnection),
    turso: vi.mocked(createClient),
    hyper: vi.mocked(postgres),
}
vi.mock('./allowlist', () => ({
    isQueryAllowed: vi.fn().mockResolvedValue(true),
}))
vi.mock('./rls', () => ({ applyRLS: vi.fn() }))
vi.mock('./cache', () => ({
    beforeQueryCache: vi.fn(),
    afterQueryCache: vi.fn(),
}))
let source: any
let config: any
const run = (extra = {}) =>
    executeQuery({
        sql: 'SELECT ?',
        params: [1],
        isRaw: false,
        dataSource: source,
        config,
        ...extra,
    })
beforeEach(() => {
    vi.clearAllMocks()
    for (const Connection of [
        PostgreSQLConnection,
        MySQLConnection,
        TursoConnection,
        CloudflareD1Connection,
        StarbaseConnection,
    ]) {
        vi.mocked(Connection).mockImplementation(
            () => ({ connect: drivers.connect, raw: drivers.raw }) as any
        )
    }
    source = {
        source: 'internal',
        rpc: { executeQuery: vi.fn().mockResolvedValue([{ id: 1 }]) },
    }
    config = { role: 'client', features: { allowlist: false, rls: false } }
    vi.mocked(applyRLS).mockImplementation(async ({ sql }) => sql)
    vi.mocked(beforeQueryCache).mockResolvedValue(null)
    vi.mocked(afterQueryCache).mockResolvedValue(undefined)
    drivers.connect.mockResolvedValue(undefined)
    drivers.raw.mockResolvedValue({ data: [{ id: 2 }] })
    drivers.unsafe.mockResolvedValue([{ id: 3 }])
    drivers.end.mockResolvedValue(undefined)
    drivers.hyper.mockReturnValue({ unsafe: drivers.unsafe, end: drivers.end })
    vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
})
it('returns empty results when source is absent', async () => {
    expect(await run({ dataSource: undefined })).toEqual([])
    expect(
        await executeTransaction({
            queries: [],
            isRaw: false,
            dataSource: undefined as any,
            config,
        })
    ).toEqual([])
})
it('uses feature defaults when configuration is absent', async () => {
    await run({ config: undefined })
    expect(applyRLS).toHaveBeenCalledWith(
        expect.objectContaining({ isEnabled: true })
    )
})
it('returns a cache hit without querying the database', async () => {
    vi.mocked(beforeQueryCache).mockResolvedValue([{ cached: true }])
    expect(await run()).toEqual([{ cached: true }])
    expect(source.rpc.executeQuery).not.toHaveBeenCalled()
})
it('passes query hook rewrites to storage and result hooks to the caller', async () => {
    source.registry = {
        beforeQuery: vi
            .fn()
            .mockResolvedValue({ sql: 'SELECT 2', params: [2] }),
        afterQuery: vi.fn().mockResolvedValue([{ hooked: true }]),
    }
    expect(await run()).toEqual([{ hooked: true }])
    expect(source.rpc.executeQuery).toHaveBeenCalledWith({
        sql: 'SELECT 2',
        params: [2],
        isRaw: false,
    })
    expect(afterQueryCache).toHaveBeenCalledOnce()
})
it('preserves results if an after-query hook fails', async () => {
    source.registry = {
        beforeQuery: vi.fn().mockResolvedValue({ sql: 'SELECT 1' }),
        afterQuery: vi.fn().mockRejectedValue(new Error('hook')),
    }
    expect(await run()).toEqual([{ id: 1 }])
})
it('returns empty results for a null internal result', async () => {
    source.rpc.executeQuery.mockResolvedValue(null)
    expect(await run()).toEqual([])
})
it.each(
    [[{ id: 1 }], { columns: ['id'], rows: [[1]] }, []].map((result) => ({
        result,
    }))
)('normalizes raw results without cache access %j', async ({ result }) => {
    source.rpc.executeQuery.mockResolvedValue(result)
    const actual = (await run({ isRaw: true })) as any
    expect(actual.columns).toEqual(
        Array.isArray(result) && result.length === 0 ? [] : ['id']
    )
    expect(beforeQueryCache).not.toHaveBeenCalled()
})
it('returns an empty raw result for missing rows', async () => {
    source.rpc.executeQuery.mockResolvedValue({ columns: [] })
    expect(await run({ isRaw: true })).toEqual({
        columns: [],
        rows: [],
        meta: { rows_read: 0, rows_written: 0 },
    })
})
it.each([undefined, {}])(
    'requires a Hyperdrive connection string %j',
    async (external) => {
        source.source = 'hyperdrive'
        source.external = external
        await expect(run()).rejects.toThrow(
            'Hyperdrive connection string not found'
        )
    }
)
it.each([false, true])(
    'closes Hyperdrive connections with execution context %s',
    async (withContext) => {
        source.source = 'hyperdrive'
        source.external = { connectionString: 'postgres://test' }
        if (withContext) source.executionContext = { waitUntil: vi.fn() }
        expect(await run()).toEqual([{ id: 3 }])
        expect(drivers.unsafe).toHaveBeenCalledWith('SELECT ?', [1])
        expect(drivers.end).toHaveBeenCalledOnce()
    }
)
it('propagates Hyperdrive query errors', async () => {
    source.source = 'hyperdrive'
    source.external = { connectionString: 'postgres://test' }
    drivers.unsafe.mockRejectedValue(new Error('query failed'))
    await expect(run()).rejects.toThrow('query failed')
})
it('dispatches an external request through the SDK', async () => {
    source.source = 'external'
    source.external = { dialect: 'postgresql' }
    expect(await run()).toEqual([{ id: 2 }])
})
it('executes transaction queries in order', async () => {
    await executeTransaction({
        queries: [{ sql: 'SELECT 1' }, { sql: 'SELECT 2', params: [2] }],
        isRaw: false,
        dataSource: source,
        config,
    })
    expect(
        source.rpc.executeQuery.mock.calls.map((c: any) => c[0].sql)
    ).toEqual(['SELECT 1', 'SELECT 2'])
})
it('requires external connection information', async () => {
    await expect(
        executeExternalQuery({
            sql: 'SELECT 1',
            params: [],
            dataSource: source,
            config,
        })
    ).rejects.toThrow('External connection not found')
})
it.each([[1, 2], { named: 1 }].map((params) => ({ params })))(
    'formats Outerbase API requests with parameters %j',
    async ({ params }) => {
        source.external = { dialect: 'mysql' }
        config.outerbaseApiKey = 'test-token'
        const fetcher = vi.fn().mockResolvedValue({
            json: async () => ({
                response: { results: { items: [{ id: 8 }] } },
            }),
        })
        vi.stubGlobal('fetch', fetcher)
        expect(
            await executeExternalQuery({
                sql: 'SELECT ?\n, ?',
                params,
                dataSource: source,
                config,
            })
        ).toEqual([{ id: 8 }])
        const body = JSON.parse(fetcher.mock.calls[0][1].body)
        expect(body.query).not.toContain('\n')
        expect(body.params).toEqual(
            Array.isArray(params) ? { param0: 1, param1: 2 } : params
        )
    }
)
it.each([null, {}, { response: {} }, { response: { results: {} } }])(
    'handles malformed API response %j',
    async (result) => {
        source.external = { dialect: 'mysql' }
        config.outerbaseApiKey = 'test-token'
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({ json: async () => result })
        )
        expect(
            await executeExternalQuery({
                sql: 'SELECT 1',
                params: undefined,
                dataSource: source,
                config,
            })
        ).toEqual([])
    }
)
it('returns no SDK results without a connection', async () => {
    expect(
        await executeSDKQuery({ sql: 'SELECT 1', dataSource: source, config })
    ).toEqual([])
})
it.each([
    { dialect: 'postgresql' },
    { dialect: 'postgresql', defaultSchema: 'custom' },
    { dialect: 'mysql' },
    { dialect: 'mysql', defaultSchema: 'custom' },
    { dialect: 'sqlite', provider: 'turso', uri: 'libsql://test' },
    { dialect: 'sqlite', provider: 'turso', defaultSchema: 'custom' },
    { dialect: 'sqlite', provider: 'cloudflare-d1' },
    { dialect: 'sqlite', provider: 'cloudflare-d1', defaultSchema: 'custom' },
    { dialect: 'sqlite', provider: 'starbase' },
    { dialect: 'sqlite', provider: 'starbase', defaultSchema: 'custom' },
])(
    'connects and runs through the supported SDK provider %j',
    async (external) => {
        source.external = external
        expect(
            await executeSDKQuery({
                sql: 'SELECT ?',
                params: [7],
                dataSource: source,
                config,
            })
        ).toEqual([{ id: 2 }])
        expect(drivers.connect).toHaveBeenCalledOnce()
        expect(drivers.raw).toHaveBeenCalledWith('SELECT ?', [7])
    }
)
it('rejects unsupported SDK providers', async () => {
    source.external = { dialect: 'sqlite', provider: 'other' }
    await expect(
        executeSDKQuery({ sql: 'SELECT 1', dataSource: source, config })
    ).rejects.toThrow('Unsupported external database type')
})
