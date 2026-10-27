import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
    executeQuery,
    executeTransaction,
    executeExternalQuery,
    executeSDKQuery,
} from './operation'
import { isQueryAllowed } from './allowlist'
import { applyRLS } from './rls'
import { beforeQueryCache, afterQueryCache } from './cache'
import type { DataSource } from './types'
import type { StarbaseDBConfiguration } from './handler'

const mockConnect = vi.fn().mockResolvedValue(undefined)
const mockRaw = vi
    .fn()
    .mockResolvedValue({ data: [{ id: 1, name: 'SDK-Test-Result' }] })

const mockPostgresUnsafe = vi
    .fn()
    .mockResolvedValue([{ id: 1, name: 'Hyperdrive-Row' }])
const mockPostgresEnd = vi.fn().mockResolvedValue(undefined)

vi.mock('pg', () => ({
    Client: vi.fn().mockImplementation(() => ({})),
}))

vi.mock('mysql2', () => ({
    createConnection: vi.fn().mockReturnValue({}),
}))

vi.mock('@libsql/client/web', () => ({
    createClient: vi.fn().mockReturnValue({}),
}))

vi.mock('postgres', () => ({
    default: vi.fn().mockImplementation(() => ({
        unsafe: mockPostgresUnsafe,
        end: mockPostgresEnd,
    })),
}))

vi.mock('@outerbase/sdk', () => ({
    PostgreSQLConnection: vi.fn().mockImplementation(() => ({
        connect: mockConnect,
        raw: mockRaw,
    })),
    MySQLConnection: vi.fn().mockImplementation(() => ({
        connect: mockConnect,
        raw: mockRaw,
    })),
    CloudflareD1Connection: vi.fn().mockImplementation(() => ({
        connect: mockConnect,
        raw: mockRaw,
    })),
    StarbaseConnection: vi.fn().mockImplementation(() => ({
        connect: mockConnect,
        raw: mockRaw,
    })),
    TursoConnection: vi.fn().mockImplementation(() => ({
        connect: mockConnect,
        raw: mockRaw,
    })),
}))

vi.mock('./allowlist', () => ({ isQueryAllowed: vi.fn() }))
vi.mock('./rls', () => ({ applyRLS: vi.fn(async ({ sql }) => sql) }))
vi.mock('./cache', () => ({
    beforeQueryCache: vi.fn(async () => null),
    afterQueryCache: vi.fn(),
}))

let mockDataSource: DataSource
let mockConfig: StarbaseDBConfiguration

beforeEach(() => {
    mockConfig = {
        outerbaseApiKey: 'mock-api-key',
        role: 'admin',
        features: { allowlist: true, rls: true, rest: true },
    }

    mockDataSource = {
        source: 'internal',
        external: {
            dialect: 'postgresql',
            provider: 'postgresql',
            host: 'mock-host',
            port: 5432,
            user: 'mock-user',
            password: 'mock-password',
            database: 'mock-db',
        } as any,
        rpc: {
            executeQuery: vi.fn().mockResolvedValue([
                { id: 1, name: 'Alice' },
                { id: 2, name: 'Bob' },
            ]),
        },
    } as any

    vi.mocked(beforeQueryCache).mockResolvedValue(null)
    vi.mocked(afterQueryCache).mockResolvedValue(undefined)
    vi.clearAllMocks()
})

describe('executeQuery', () => {
    it('should execute a valid SQL query', async () => {
        const result = await executeQuery({
            sql: 'SELECT * FROM users',
            params: undefined,
            isRaw: false,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: 'SELECT * FROM users',
            params: undefined,
            isRaw: false,
        })
        expect(result).toEqual([
            { id: 1, name: 'Alice' },
            { id: 2, name: 'Bob' },
        ])
    })

    it('should transform raw results and invoke registry beforeQuery and afterQuery hooks', async () => {
        const rawRpcPayload = {
            columns: ['id', 'name'],
            rows: [
                [1, 'Alice'],
                [2, 'Bob'],
            ],
            meta: { rows_read: 2, rows_written: 0 },
        }
        vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValueOnce(
            rawRpcPayload as any
        )

        mockDataSource.registry = {
            beforeQuery: vi.fn(async ({ sql, params }) => ({
                sql: `${sql} -- hooked`,
                params,
            })),
            afterQuery: vi.fn(async ({ result }) => result),
        } as any

        const result = await executeQuery({
            sql: 'SELECT * FROM users',
            params: [],
            isRaw: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(mockDataSource.registry!.beforeQuery).toHaveBeenCalled()
        expect(mockDataSource.registry!.afterQuery).toHaveBeenCalled()
        expect(result).toEqual(rawRpcPayload)
    })

    it('should handle array input in raw mode and catch errors in registry.afterQuery', async () => {
        const consoleErrorSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})
        mockDataSource.registry = {
            beforeQuery: vi.fn(async ({ sql, params }) => ({ sql, params })),
            afterQuery: vi.fn().mockRejectedValueOnce(new Error('Hook error')),
        } as any

        const result = await executeQuery({
            sql: 'SELECT * FROM users',
            params: [],
            isRaw: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(result).toEqual({
            columns: ['id', 'name'],
            rows: [
                [1, 'Alice'],
                [2, 'Bob'],
            ],
            meta: { rows_read: 2, rows_written: 0 },
        })
        expect(consoleErrorSpy).toHaveBeenCalled()
        consoleErrorSpy.mockRestore()
    })

    it('should return empty array when internal rpc.executeQuery returns null', async () => {
        const consoleErrorSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})
        vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValueOnce(
            null as any
        )

        const result = await executeQuery({
            sql: 'SELECT * FROM users',
            params: undefined,
            isRaw: false,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(result).toEqual([])
        consoleErrorSpy.mockRestore()
    })

    it('should execute queries via hyperdrive with and without executionContext and handle errors', async () => {
        const waitUntilMock = vi.fn()
        const hyperdriveSource: DataSource = {
            ...mockDataSource,
            source: 'hyperdrive',
            external: {
                dialect: 'postgresql',
                connectionString: 'postgres://user:pass@host:5432/db',
            },
            executionContext: { waitUntil: waitUntilMock } as any,
        }

        const res1 = await executeQuery({
            sql: 'SELECT 1',
            params: [],
            isRaw: false,
            dataSource: hyperdriveSource,
            config: mockConfig,
        })
        expect(res1).toEqual([{ id: 1, name: 'Hyperdrive-Row' }])
        expect(waitUntilMock).toHaveBeenCalled()

        // Without executionContext
        hyperdriveSource.executionContext = undefined
        await executeQuery({
            sql: 'SELECT 1',
            params: [],
            isRaw: false,
            dataSource: hyperdriveSource,
            config: mockConfig,
        })
        expect(mockPostgresEnd).toHaveBeenCalled()

        // Hyperdrive query error
        const consoleErrorSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})
        mockPostgresUnsafe.mockRejectedValueOnce(new Error('PG failure'))
        await expect(
            executeQuery({
                sql: 'SELECT 1',
                params: [],
                isRaw: false,
                dataSource: hyperdriveSource,
                config: mockConfig,
            })
        ).rejects.toThrow('PG failure')
        consoleErrorSpy.mockRestore()

        // Missing connectionString
        await expect(
            executeQuery({
                sql: 'SELECT 1',
                params: [],
                isRaw: false,
                dataSource: {
                    ...mockDataSource,
                    source: 'hyperdrive',
                    external: undefined,
                },
                config: mockConfig,
            })
        ).rejects.toThrow('Hyperdrive connection string not found')
    })

    it('should execute external queries when dataSource.source is external', async () => {
        const externalDataSource: DataSource = {
            ...mockDataSource,
            source: 'external',
        }
        const configNoApiKey = { ...mockConfig, outerbaseApiKey: undefined }

        const res = await executeQuery({
            sql: 'SELECT * FROM users',
            params: [],
            isRaw: false,
            dataSource: externalDataSource,
            config: configNoApiKey,
        })

        expect(res).toEqual([{ id: 1, name: 'SDK-Test-Result' }])
    })

    it('should enforce the allowlist feature', async () => {
        await executeQuery({
            sql: 'SELECT * FROM users',
            params: undefined,
            isRaw: false,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(isQueryAllowed).toHaveBeenCalledTimes(1)
        expect(isQueryAllowed).toHaveBeenCalledWith(
            expect.objectContaining({ sql: 'SELECT * FROM users' })
        )
    })

    it('should apply row-level security', async () => {
        await executeQuery({
            sql: 'SELECT * FROM users',
            params: undefined,
            isRaw: false,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(applyRLS).toHaveBeenCalledWith(
            expect.objectContaining({ sql: 'SELECT * FROM users' })
        )
    })

    it('should return cached results if available', async () => {
        ;(beforeQueryCache as any).mockResolvedValue([
            { id: 99, name: 'Cached' },
        ])

        const result = await executeQuery({
            sql: 'SELECT * FROM users',
            params: undefined,
            isRaw: false,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(result).toEqual([{ id: 99, name: 'Cached' }])
        expect(mockDataSource.rpc.executeQuery).not.toHaveBeenCalled()
    })

    it('should return an empty array if the data source is missing', async () => {
        const consoleErrorSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})
        const result = await executeQuery({
            sql: 'SELECT * FROM users',
            params: undefined,
            isRaw: false,
            dataSource: null as any,
            config: mockConfig,
        })
        expect(result).toEqual([])
        consoleErrorSpy.mockRestore()
    })
})

describe('executeTransaction', () => {
    it('should execute multiple queries in a transaction', async () => {
        const queries = [
            { sql: 'INSERT INTO users VALUES (1, "Alice")' },
            { sql: 'INSERT INTO users VALUES (2, "Bob")' },
        ]

        await executeTransaction({
            queries,
            isRaw: false,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledTimes(2)
        expect(queries.length).toBe(2)
    })

    it('should return an empty array if the data source is missing', async () => {
        const consoleErrorMock = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})

        const result = await executeTransaction({
            queries: [{ sql: 'INSERT INTO users VALUES (1, "Alice")' }],
            isRaw: false,
            dataSource: null as any,
            config: mockConfig,
        })
        expect(result).toEqual([])
        consoleErrorMock.mockRestore()
    })
})

describe('executeExternalQuery', () => {
    it('should throw an error if dataSource.external is missing', async () => {
        await expect(
            executeExternalQuery({
                sql: 'SELECT * FROM users',
                params: [],
                dataSource: { source: 'internal' } as any,
                config: mockConfig,
            })
        ).rejects.toThrow('External connection not found.')
    })

    it('should delegate to executeSDKQuery if outerbaseApiKey is missing', async () => {
        const result = await executeExternalQuery({
            sql: 'SELECT * FROM users',
            params: [],
            dataSource: mockDataSource,
            config: { ...mockConfig, outerbaseApiKey: undefined },
        })

        expect(result).toEqual([{ id: 1, name: 'SDK-Test-Result' }])
    })

    it('should correctly format SQL and parameters for API request', async () => {
        const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce({
            json: async () => ({
                response: {
                    results: { items: [{ id: 2, name: 'API-Result' }] },
                },
            }),
        } as Response)

        const result = await executeExternalQuery({
            sql: 'SELECT * FROM users WHERE id = ?',
            params: [5],
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(fetchMock).toHaveBeenCalledWith(
            'https://app.outerbase.com/api/v1/ezql/raw',
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Source-Token': 'mock-api-key',
                },
                body: JSON.stringify({
                    query: 'SELECT * FROM users WHERE id = :param0',
                    params: { param0: 5 },
                }),
            }
        )

        expect(result).toEqual([{ id: 2, name: 'API-Result' }])
        fetchMock.mockRestore()
    })

    it('should handle API failure gracefully', async () => {
        const fetchMock = vi
            .spyOn(global, 'fetch')
            .mockRejectedValueOnce(new Error('Network error'))

        await expect(
            executeExternalQuery({
                sql: 'SELECT * FROM users',
                params: [],
                dataSource: mockDataSource,
                config: mockConfig,
            })
        ).rejects.toThrow('Network error')

        expect(fetchMock).toHaveBeenCalled()
        fetchMock.mockRestore()
    })

    it('should return an empty array if API response is malformed', async () => {
        const consoleErrorSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})
        const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce({
            json: async () => ({}),
        } as Response)

        const result = await executeExternalQuery({
            sql: 'SELECT * FROM users',
            params: [],
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(result).toEqual([])
        fetchMock.mockRestore()
        consoleErrorSpy.mockRestore()
    })
})

describe('executeSDKQuery', () => {
    it('should execute queries across postgresql, mysql, cloudflare-d1, starbase, and turso connections', async () => {
        // PostgreSQL
        expect(
            await executeSDKQuery({
                sql: 'SELECT 1',
                params: [],
                dataSource: mockDataSource,
                config: mockConfig,
            })
        ).toEqual([{ id: 1, name: 'SDK-Test-Result' }])

        // MySQL
        mockDataSource.external = {
            dialect: 'mysql',
            host: 'localhost',
            port: 3306,
            user: 'root',
            password: '',
            database: 'test',
        }
        expect(
            await executeSDKQuery({
                sql: 'SELECT 1',
                params: [],
                dataSource: mockDataSource,
                config: mockConfig,
            })
        ).toEqual([{ id: 1, name: 'SDK-Test-Result' }])

        // Cloudflare D1
        mockDataSource.external = {
            dialect: 'sqlite',
            provider: 'cloudflare-d1',
            apiKey: 'k',
            accountId: 'a',
            databaseId: 'd',
        }
        expect(
            await executeSDKQuery({
                sql: 'SELECT 1',
                params: [],
                dataSource: mockDataSource,
                config: mockConfig,
            })
        ).toEqual([{ id: 1, name: 'SDK-Test-Result' }])

        // Starbase
        mockDataSource.external = {
            dialect: 'sqlite',
            provider: 'starbase',
            apiKey: 'k',
            token: 't',
        }
        expect(
            await executeSDKQuery({
                sql: 'SELECT 1',
                params: [],
                dataSource: mockDataSource,
                config: mockConfig,
            })
        ).toEqual([{ id: 1, name: 'SDK-Test-Result' }])

        // Turso
        mockDataSource.external = {
            dialect: 'sqlite',
            provider: 'turso',
            uri: 'libsql://test',
            token: 't',
        }
        expect(
            await executeSDKQuery({
                sql: 'SELECT 1',
                params: [],
                dataSource: mockDataSource,
                config: mockConfig,
            })
        ).toEqual([{ id: 1, name: 'SDK-Test-Result' }])
    })

    it('should return empty array when external is missing and throw on unsupported type', async () => {
        const consoleWarnSpy = vi
            .spyOn(console, 'warn')
            .mockImplementation(() => {})
        mockDataSource.external = undefined
        expect(
            await executeSDKQuery({
                sql: 'SELECT 1',
                params: [],
                dataSource: mockDataSource,
                config: mockConfig,
            })
        ).toEqual([])
        consoleWarnSpy.mockRestore()

        mockDataSource.external = {
            dialect: 'sqlite',
            provider: 'unknown' as any,
        } as any
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
