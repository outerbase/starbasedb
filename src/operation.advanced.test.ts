import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
    executeQuery,
    executeTransaction,
    executeExternalQuery,
    executeSDKQuery,
} from './operation'
import { beforeQueryCache, afterQueryCache } from './cache'
import type { DataSource } from './types'
import type { StarbaseDBConfiguration } from './handler'

vi.mock('./cache', () => ({
    beforeQueryCache: vi.fn().mockResolvedValue(null),
    afterQueryCache: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('./allowlist', () => ({
    isQueryAllowed: vi.fn().mockResolvedValue(true),
}))

vi.mock('./rls', () => ({
    applyRLS: vi.fn().mockImplementation(({ sql }) => sql),
}))

vi.mock('pg', () => ({
    Client: vi.fn().mockImplementation(() => ({ connect: vi.fn() })),
}))

vi.mock('mysql2', () => ({
    createConnection: vi.fn(() => ({ connect: vi.fn() })),
}))

vi.mock('@libsql/client/web', () => ({
    createClient: vi.fn(() => ({})),
}))

vi.mock('postgres', () => ({
    default: vi.fn(() => ({
        unsafe: vi.fn().mockResolvedValue([{ id: 1 }]),
        end: vi.fn().mockResolvedValue(undefined),
    })),
}))

const mockRaw = vi.fn().mockResolvedValue({ data: [{ id: 1 }] })

vi.mock('@outerbase/sdk', () => ({
    CloudflareD1Connection: vi.fn().mockImplementation(() => ({
        connect: vi.fn(),
        raw: mockRaw,
    })),
    MySQLConnection: vi.fn().mockImplementation(() => ({
        connect: vi.fn(),
        raw: mockRaw,
    })),
    PostgreSQLConnection: vi.fn().mockImplementation(() => ({
        connect: vi.fn(),
        raw: mockRaw,
    })),
    StarbaseConnection: vi.fn().mockImplementation(() => ({
        connect: vi.fn(),
        raw: mockRaw,
    })),
    TursoConnection: vi.fn().mockImplementation(() => ({
        connect: vi.fn(),
        raw: mockRaw,
    })),
}))

let mockDataSource: DataSource
let mockConfig: StarbaseDBConfiguration

beforeEach(() => {
    vi.clearAllMocks()
    ;(beforeQueryCache as any).mockResolvedValue(null)
    ;(afterQueryCache as any).mockResolvedValue(undefined)

    mockDataSource = {
        source: 'internal',
        rpc: { executeQuery: vi.fn().mockResolvedValue([{ id: 1 }]) },
    } as any

    mockConfig = {
        outerbaseApiKey: undefined,
        role: 'admin',
        features: { allowlist: false, rls: false },
    } as any
})

describe('operation module - advanced behaviors', () => {
    it('returns an empty array when no data source is provided', async () => {
        const result = await executeQuery({
            sql: 'SELECT 1',
            params: undefined,
            isRaw: false,
            dataSource: undefined as any,
            config: mockConfig,
        })

        expect(result).toEqual([])
    })

    it('executes internal queries through the rpc binding', async () => {
        const result = await executeQuery({
            sql: 'SELECT * FROM users',
            params: undefined,
            isRaw: false,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(result).toEqual([{ id: 1 }])
        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: 'SELECT * FROM users',
            params: undefined,
            isRaw: false,
        })
    })

    it('returns an empty array when the internal query returns nothing', async () => {
        ;(mockDataSource.rpc.executeQuery as any).mockResolvedValue(null)

        const result = await executeQuery({
            sql: 'SELECT 1',
            params: undefined,
            isRaw: false,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(result).toEqual([])
    })

    it('returns the cached response when one exists for the query', async () => {
        const { beforeQueryCache } = await import('./cache')
        ;(beforeQueryCache as any).mockResolvedValue([{ cached: true }])

        const result = await executeQuery({
            sql: 'SELECT * FROM users',
            params: undefined,
            isRaw: false,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(result).toEqual([{ cached: true }])
        expect(mockDataSource.rpc.executeQuery).not.toHaveBeenCalled()
    })

    it('skips the cache lookup for raw queries', async () => {
        const { beforeQueryCache } = await import('./cache')

        await executeQuery({
            sql: 'SELECT 1',
            params: undefined,
            isRaw: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(beforeQueryCache).not.toHaveBeenCalled()
    })

    it('stores results in the cache for non-raw queries', async () => {
        const { afterQueryCache } = await import('./cache')

        await executeQuery({
            sql: 'SELECT 1',
            params: undefined,
            isRaw: false,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(afterQueryCache).toHaveBeenCalled()
    })

    it('transforms raw results for raw internal queries', async () => {
        ;(mockDataSource.rpc.executeQuery as any).mockResolvedValue({
            columns: ['id', 'name'],
            rows: [[1, 'Alice']],
        })

        const result = (await executeQuery({
            sql: 'SELECT id, name FROM users',
            params: undefined,
            isRaw: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })) as any

        expect(result.rows).toEqual([[1, 'Alice']])
    })

    it('applies the registry beforeQuery and afterQuery hooks', async () => {
        mockDataSource.registry = {
            beforeQuery: vi
                .fn()
                .mockResolvedValue({ sql: 'SELECT patched', params: [1] }),
            afterQuery: vi
                .fn()
                .mockImplementation(({ result }: any) => [
                    ...result,
                    { extra: true },
                ]),
        } as any

        const result = await executeQuery({
            sql: 'SELECT * FROM users',
            params: undefined,
            isRaw: false,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledWith(
            expect.objectContaining({ sql: 'SELECT patched', params: [1] })
        )
        expect(result).toEqual([{ id: 1 }, { extra: true }])
    })

    it('continues with the unmodified result when the registry afterQuery hook fails', async () => {
        mockDataSource.registry = {
            beforeQuery: vi
                .fn()
                .mockResolvedValue({
                    sql: 'SELECT patched',
                    params: undefined,
                }),
            afterQuery: vi.fn().mockRejectedValue(new Error('hook blew up')),
        } as any

        const result = await executeQuery({
            sql: 'SELECT * FROM users',
            params: undefined,
            isRaw: false,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(result).toEqual([{ id: 1 }])
    })

    it('executes hyperdrive queries through a postgres pool', async () => {
        mockDataSource.source = 'hyperdrive'
        mockDataSource.external = {
            dialect: 'postgresql',
            connectionString: 'postgres://hyperdrive',
        } as any

        const result = await executeQuery({
            sql: 'SELECT 1',
            params: undefined,
            isRaw: false,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(result).toEqual([{ id: 1 }])
    })

    it('ends the postgres pool via waitUntil when an execution context exists', async () => {
        mockDataSource.source = 'hyperdrive'
        mockDataSource.external = {
            dialect: 'postgresql',
            connectionString: 'postgres://hyperdrive',
        } as any
        mockDataSource.executionContext = { waitUntil: vi.fn() } as any

        await executeQuery({
            sql: 'SELECT 1',
            params: undefined,
            isRaw: false,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(mockDataSource.executionContext.waitUntil).toHaveBeenCalled()
    })

    it('throws when hyperdrive has no connection string', async () => {
        mockDataSource.source = 'hyperdrive'
        mockDataSource.external = { dialect: 'postgresql' } as any

        await expect(
            executeQuery({
                sql: 'SELECT 1',
                params: undefined,
                isRaw: false,
                dataSource: mockDataSource,
                config: mockConfig,
            })
        ).rejects.toThrow('Hyperdrive connection string not found')
    })

    it('rethrows hyperdrive query failures', async () => {
        const postgres = (await import('postgres')).default as any
        ;(postgres as any).mockImplementation(() => ({
            unsafe: vi.fn().mockRejectedValue(new Error('pg down')),
            end: vi.fn().mockResolvedValue(undefined),
        }))

        mockDataSource.source = 'hyperdrive'
        mockDataSource.external = {
            dialect: 'postgresql',
            connectionString: 'postgres://hyperdrive',
        } as any

        await expect(
            executeQuery({
                sql: 'SELECT 1',
                params: undefined,
                isRaw: false,
                dataSource: mockDataSource,
                config: mockConfig,
            })
        ).rejects.toThrow('pg down')
    })

    it('routes external source queries through executeExternalQuery', async () => {
        mockDataSource.source = 'external'
        mockDataSource.external = {
            dialect: 'postgresql',
            host: 'db',
            port: 5432,
            user: 'u',
            password: 'p',
            database: 'd',
        } as any
        mockConfig.outerbaseApiKey = 'ob-key'

        const fetchSpy = vi.fn().mockResolvedValue({
            json: () =>
                Promise.resolve({
                    response: { results: { items: [{ row: 'a' }] } },
                }),
        })
        vi.stubGlobal('fetch', fetchSpy)

        const result = await executeQuery({
            sql: 'SELECT 1',
            params: undefined,
            isRaw: false,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(result).toEqual([{ row: 'a' }])
        vi.unstubAllGlobals()
    })

    it('executeTransaction aggregates results for each query', async () => {
        const result = await executeTransaction({
            queries: [{ sql: 'SELECT 1' }, { sql: 'SELECT 2' }],
            isRaw: false,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(result).toHaveLength(2)
    })

    it('executeTransaction returns an empty array without a data source', async () => {
        const result = await executeTransaction({
            queries: [{ sql: 'SELECT 1' }],
            isRaw: false,
            dataSource: undefined as any,
            config: mockConfig,
        })

        expect(result).toEqual([])
    })

    it('executeExternalQuery throws when no external connection exists', async () => {
        await expect(
            executeExternalQuery({
                sql: 'SELECT 1',
                params: [],
                dataSource: mockDataSource,
                config: mockConfig,
            })
        ).rejects.toThrow('External connection not found.')
    })

    it('executeExternalQuery delegates to the SDK when no API key is configured', async () => {
        mockDataSource.external = {
            dialect: 'postgresql',
            host: 'db',
            port: 5432,
            user: 'u',
            password: 'p',
            database: 'd',
        } as any

        const result = await executeExternalQuery({
            sql: 'SELECT 1',
            params: [],
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(result).toEqual([{ id: 1 }])
    })

    it('executeExternalQuery converts array params and calls the Outerbase API', async () => {
        mockDataSource.external = { dialect: 'postgresql' } as any
        mockConfig.outerbaseApiKey = 'ob-key'

        const fetchSpy = vi.fn().mockResolvedValue({
            json: () =>
                Promise.resolve({
                    response: { results: { items: [{ id: 1 }] } },
                }),
        })
        vi.stubGlobal('fetch', fetchSpy)

        const result = await executeExternalQuery({
            sql: 'SELECT * FROM users WHERE id = ?',
            params: [5],
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(result).toEqual([{ id: 1 }])
        const [url, init] = fetchSpy.mock.calls[0]
        expect(url).toBe('https://app.outerbase.com/api/v1/ezql/raw')
        expect(init.headers['X-Source-Token']).toBe('ob-key')
        expect(init.body).toContain(':param0')
        vi.unstubAllGlobals()
    })

    it('executeExternalQuery returns an empty array for malformed API responses', async () => {
        mockDataSource.external = { dialect: 'postgresql' } as any
        mockConfig.outerbaseApiKey = 'ob-key'

        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                json: () => Promise.resolve({ unexpected: true }),
            })
        )

        const result = await executeExternalQuery({
            sql: 'SELECT 1',
            params: [],
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(result).toEqual([])
        vi.unstubAllGlobals()
    })

    it('executeSDKQuery returns an empty array when there is no external connection', async () => {
        const result = await executeSDKQuery({
            sql: 'SELECT 1',
            params: [],
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(result).toEqual([])
    })

    it.each([
        [
            'postgresql',
            {
                dialect: 'postgresql',
                host: 'db',
                port: 5432,
                user: 'u',
                password: 'p',
                database: 'd',
            },
        ],
        [
            'mysql',
            {
                dialect: 'mysql',
                host: 'db',
                port: 3306,
                user: 'u',
                password: 'p',
                database: 'd',
            },
        ],
        [
            'cloudflare-d1',
            {
                dialect: 'sqlite',
                provider: 'cloudflare-d1',
                apiKey: 'key',
                accountId: 'acct',
                databaseId: 'dbid',
            },
        ],
        [
            'starbase',
            {
                dialect: 'sqlite',
                provider: 'starbase',
                apiKey: 'https://api',
                token: 'token',
            },
        ],
        [
            'turso',
            {
                dialect: 'sqlite',
                provider: 'turso',
                uri: 'libsql://example',
                token: 'token',
            },
        ],
    ])(
        'executeSDKQuery connects through the %s driver',
        async (_, external) => {
            mockDataSource.external = external as any

            const result = await executeSDKQuery({
                sql: 'SELECT 1',
                params: [],
                dataSource: mockDataSource,
                config: mockConfig,
            })

            expect(result).toEqual([{ id: 1 }])
        }
    )

    it('executeSDKQuery throws for unsupported providers', async () => {
        mockDataSource.external = { dialect: 'mongodb' } as any

        await expect(
            executeSDKQuery({
                sql: 'SELECT 1',
                params: [],
                dataSource: mockDataSource,
                config: mockConfig,
            })
        ).rejects.toThrow('Unsupported external database type')
    })
})
