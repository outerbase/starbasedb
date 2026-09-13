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

const mockRaw = vi.fn().mockResolvedValue({ data: [{ id: 1, name: 'SDK-Result' }] })
const mockConnect = vi.fn().mockResolvedValue(undefined)

vi.mock('@outerbase/sdk', () => {
    class MockConnection {
        connect = mockConnect
        raw = mockRaw
    }
    return {
        PostgreSQLConnection: MockConnection,
        MySQLConnection: MockConnection,
        CloudflareD1Connection: MockConnection,
        StarbaseConnection: MockConnection,
        TursoConnection: MockConnection,
    }
})

vi.mock('pg', () => ({
    Client: vi.fn(),
}))

vi.mock('mysql2', () => ({
    createConnection: vi.fn(),
}))

vi.mock('@libsql/client/web', () => ({
    createClient: vi.fn(),
}))

const mockSqlUnsafe = vi.fn().mockResolvedValue([{ id: 10, name: 'Hyperdrive-Result' }])
const mockSqlEnd = vi.fn().mockResolvedValue(undefined)
const mockPostgres = vi.fn().mockReturnValue({
    unsafe: mockSqlUnsafe,
    end: mockSqlEnd,
})
vi.mock('postgres', () => ({
    default: (...args: any[]) => mockPostgres(...args),
}))

vi.mock('./allowlist', () => ({ isQueryAllowed: vi.fn() }))
vi.mock('./rls', () => ({ applyRLS: vi.fn(async ({ sql }) => sql) }))
vi.mock('./cache', () => ({
    beforeQueryCache: vi.fn(async () => null),
    afterQueryCache: vi.fn(),
}))

describe('operation module', () => {
    let mockDataSource: DataSource
    let mockConfig: StarbaseDBConfiguration

    beforeEach(() => {
        vi.clearAllMocks()

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
            } as any,
        }

        vi.mocked(beforeQueryCache).mockResolvedValue(null)
        vi.mocked(afterQueryCache).mockResolvedValue(null)
        mockSqlUnsafe.mockResolvedValue([{ id: 10, name: 'Hyperdrive-Result' }])
        mockSqlEnd.mockResolvedValue(undefined)
        mockRaw.mockResolvedValue({ data: [{ id: 1, name: 'SDK-Result' }] })
        mockConnect.mockResolvedValue(undefined)
    })

    describe('executeQuery', () => {
        it('should execute a valid SQL query on internal source', async () => {
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

        it('should handle raw results transformation', async () => {
            mockDataSource.rpc.executeQuery = vi.fn().mockResolvedValue({
                columns: ['id', 'name'],
                rows: [[1, 'Alice'], [2, 'Bob']],
            })

            const result = await executeQuery({
                sql: 'SELECT * FROM users',
                params: undefined,
                isRaw: true,
                dataSource: mockDataSource,
                config: mockConfig,
            })

            expect(result).toEqual({
                columns: ['id', 'name'],
                rows: [[1, 'Alice'], [2, 'Bob']],
                meta: {
                    rows_read: 2,
                    rows_written: 0,
                },
            })
        })

        it('should return an empty array if internal source returns null or empty', async () => {
            mockDataSource.rpc.executeQuery = vi.fn().mockResolvedValue(null)

            const result = await executeQuery({
                sql: 'SELECT * FROM users',
                params: undefined,
                isRaw: false,
                dataSource: mockDataSource,
                config: mockConfig,
            })

            expect(result).toEqual([])
        })

        it('should return an empty array if data source is missing', async () => {
            const result = await executeQuery({
                sql: 'SELECT * FROM users',
                params: undefined,
                isRaw: false,
                dataSource: null as any,
                config: mockConfig,
            })

            expect(result).toEqual([])
        })

        it('should enforce the allowlist feature', async () => {
            await executeQuery({
                sql: 'SELECT * FROM users',
                params: undefined,
                isRaw: false,
                dataSource: mockDataSource,
                config: mockConfig,
            })

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
            vi.mocked(beforeQueryCache).mockResolvedValueOnce([{ id: 99, name: 'Cached' }])

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

        it('should execute query via Hyperdrive with executionContext', async () => {
            const waitMock = vi.fn()
            const ds: DataSource = {
                source: 'hyperdrive',
                external: {
                    dialect: 'postgresql',
                    connectionString: 'postgres://user:pass@host:5432/db',
                },
                rpc: {} as any,
                executionContext: { waitUntil: waitMock } as any,
            }

            const result = await executeQuery({
                sql: 'SELECT * FROM items',
                params: ['a'],
                isRaw: false,
                dataSource: ds,
                config: mockConfig,
            })

            expect(mockSqlUnsafe).toHaveBeenCalledWith('SELECT * FROM items', ['a'])
            expect(waitMock).toHaveBeenCalled()
            expect(result).toEqual([{ id: 10, name: 'Hyperdrive-Result' }])
        })

        it('should execute query via Hyperdrive without executionContext', async () => {
            const ds: DataSource = {
                source: 'hyperdrive',
                external: {
                    dialect: 'postgresql',
                    connectionString: 'postgres://user:pass@host:5432/db',
                },
                rpc: {} as any,
            }

            const result = await executeQuery({
                sql: 'SELECT * FROM items',
                params: undefined,
                isRaw: false,
                dataSource: ds,
                config: mockConfig,
            })

            expect(mockSqlEnd).toHaveBeenCalled()
            expect(result).toEqual([{ id: 10, name: 'Hyperdrive-Result' }])
        })

        it('should throw error when Hyperdrive connection string is missing', async () => {
            const ds: DataSource = {
                source: 'hyperdrive',
                external: { dialect: 'postgresql' } as any,
                rpc: {} as any,
            }

            await expect(
                executeQuery({
                    sql: 'SELECT 1',
                    params: undefined,
                    isRaw: false,
                    dataSource: ds,
                    config: mockConfig,
                })
            ).rejects.toThrow('Hyperdrive connection string not found')
        })

        it('should rethrow error if Hyperdrive query fails', async () => {
            mockSqlUnsafe.mockRejectedValueOnce(new Error('Connection lost'))
            const ds: DataSource = {
                source: 'hyperdrive',
                external: {
                    dialect: 'postgresql',
                    connectionString: 'postgres://user:pass@host:5432/db',
                },
                rpc: {} as any,
            }

            await expect(
                executeQuery({
                    sql: 'SELECT 1',
                    params: undefined,
                    isRaw: false,
                    dataSource: ds,
                    config: mockConfig,
                })
            ).rejects.toThrow('Connection lost')
        })

        it('should trigger beforeQuery and afterQuery plugin registry hooks', async () => {
            const beforeQueryMock = vi.fn().mockResolvedValue({
                sql: 'SELECT * FROM rewritten',
                params: [42],
            })
            const afterQueryMock = vi.fn().mockResolvedValue([{ id: 42, name: 'Hooked' }])

            mockDataSource.registry = {
                beforeQuery: beforeQueryMock,
                afterQuery: afterQueryMock,
            } as any

            const result = await executeQuery({
                sql: 'SELECT * FROM original',
                params: [1],
                isRaw: false,
                dataSource: mockDataSource,
                config: mockConfig,
            })

            expect(beforeQueryMock).toHaveBeenCalled()
            expect(afterQueryMock).toHaveBeenCalled()
            expect(result).toEqual([{ id: 42, name: 'Hooked' }])
        })

        it('should catch error in afterQuery hook without failing query', async () => {
            mockDataSource.registry = {
                beforeQuery: vi.fn().mockResolvedValue({
                    sql: 'SELECT * FROM users',
                    params: undefined,
                }),
                afterQuery: vi.fn().mockRejectedValue(new Error('Hook failed')),
            } as any

            const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
            const result = await executeQuery({
                sql: 'SELECT * FROM users',
                params: undefined,
                isRaw: false,
                dataSource: mockDataSource,
                config: mockConfig,
            })

            expect(consoleSpy).toHaveBeenCalled()
            expect(result).toEqual([
                { id: 1, name: 'Alice' },
                { id: 2, name: 'Bob' },
            ])
        })
    })

    describe('executeTransaction', () => {
        it('should execute multiple queries in a transaction', async () => {
            const queries = [
                { sql: 'INSERT INTO users VALUES (1, "Alice")' },
                { sql: 'INSERT INTO users VALUES (2, "Bob")' },
            ]

            const result = await executeTransaction({
                queries,
                isRaw: false,
                dataSource: mockDataSource,
                config: mockConfig,
            })

            expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledTimes(2)
            expect(result).toHaveLength(2)
        })

        it('should return an empty array if data source is missing in transaction', async () => {
            const result = await executeTransaction({
                queries: [{ sql: 'INSERT INTO users VALUES (1, "Alice")' }],
                isRaw: false,
                dataSource: null as any,
                config: mockConfig,
            })

            expect(result).toEqual([])
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

        it('should call executeSDKQuery if outerbaseApiKey is missing', async () => {
            const configWithoutApiKey = {
                ...mockConfig,
                outerbaseApiKey: undefined,
            }

            const result = await executeExternalQuery({
                sql: 'SELECT * FROM users',
                params: [],
                dataSource: mockDataSource,
                config: configWithoutApiKey,
            })

            expect(mockConnect).toHaveBeenCalled()
            expect(mockRaw).toHaveBeenCalledWith('SELECT * FROM users', [])
            expect(result).toEqual([{ id: 1, name: 'SDK-Result' }])
        })

        it('should correctly format SQL and parameters for API request with array params', async () => {
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
        })

        it('should correctly handle non-array params for API request', async () => {
            const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce({
                json: async () => ({
                    response: {
                        results: { items: [{ id: 3, name: 'Named-Result' }] },
                    },
                }),
            } as Response)

            const result = await executeExternalQuery({
                sql: 'SELECT * FROM users WHERE id = :id',
                params: { id: 10 },
                dataSource: mockDataSource,
                config: mockConfig,
            })

            expect(fetchMock).toHaveBeenCalledWith(
                'https://app.outerbase.com/api/v1/ezql/raw',
                expect.objectContaining({
                    body: JSON.stringify({
                        query: 'SELECT * FROM users WHERE id = :id',
                        params: { id: 10 },
                    }),
                })
            )

            expect(result).toEqual([{ id: 3, name: 'Named-Result' }])
        })

        it('should handle API failure gracefully', async () => {
            vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('Network error'))

            await expect(
                executeExternalQuery({
                    sql: 'SELECT * FROM users',
                    params: [],
                    dataSource: mockDataSource,
                    config: mockConfig,
                })
            ).rejects.toThrow('Network error')
        })

        it('should return an empty array if API response is malformed', async () => {
            vi.spyOn(global, 'fetch').mockResolvedValueOnce({
                json: async () => ({}),
            } as Response)

            const result = await executeExternalQuery({
                sql: 'SELECT * FROM users',
                params: [],
                dataSource: mockDataSource,
                config: mockConfig,
            })

            expect(result).toEqual([])
        })
    })

    describe('executeSDKQuery', () => {
        it('should return empty array if external config is missing', async () => {
            const ds: DataSource = { source: 'external', rpc: {} as any }
            const result = await executeSDKQuery({
                sql: 'SELECT 1',
                dataSource: ds,
                config: mockConfig,
            })
            expect(result).toEqual([])
        })

        it('should execute query with PostgreSQL driver', async () => {
            const ds: DataSource = {
                source: 'external',
                external: {
                    dialect: 'postgresql',
                    host: 'localhost',
                    port: 5432,
                    user: 'user',
                    password: 'password',
                    database: 'db',
                },
                rpc: {} as any,
            }

            const result = await executeSDKQuery({
                sql: 'SELECT * FROM pg_table',
                params: [1],
                dataSource: ds,
                config: mockConfig,
            })

            expect(mockConnect).toHaveBeenCalled()
            expect(mockRaw).toHaveBeenCalledWith('SELECT * FROM pg_table', [1])
            expect(result).toEqual([{ id: 1, name: 'SDK-Result' }])
        })

        it('should execute query with MySQL driver', async () => {
            const ds: DataSource = {
                source: 'external',
                external: {
                    dialect: 'mysql',
                    host: 'localhost',
                    port: 3306,
                    user: 'root',
                    password: 'password',
                    database: 'db',
                },
                rpc: {} as any,
            }

            const result = await executeSDKQuery({
                sql: 'SELECT * FROM my_table',
                dataSource: ds,
                config: mockConfig,
            })

            expect(mockConnect).toHaveBeenCalled()
            expect(result).toEqual([{ id: 1, name: 'SDK-Result' }])
        })

        it('should execute query with Cloudflare D1 provider', async () => {
            const ds: DataSource = {
                source: 'external',
                external: {
                    dialect: 'sqlite',
                    provider: 'cloudflare-d1',
                    apiKey: 'cf-key',
                    accountId: 'cf-acc',
                    databaseId: 'cf-db',
                },
                rpc: {} as any,
            }

            const result = await executeSDKQuery({
                sql: 'SELECT * FROM d1_table',
                dataSource: ds,
                config: mockConfig,
            })

            expect(mockConnect).toHaveBeenCalled()
            expect(result).toEqual([{ id: 1, name: 'SDK-Result' }])
        })

        it('should execute query with Starbase provider', async () => {
            const ds: DataSource = {
                source: 'external',
                external: {
                    dialect: 'sqlite',
                    provider: 'starbase',
                    apiKey: 'sb-key',
                    token: 'sb-url',
                },
                rpc: {} as any,
            }

            const result = await executeSDKQuery({
                sql: 'SELECT * FROM sb_table',
                dataSource: ds,
                config: mockConfig,
            })

            expect(mockConnect).toHaveBeenCalled()
            expect(result).toEqual([{ id: 1, name: 'SDK-Result' }])
        })

        it('should execute query with Turso provider', async () => {
            const ds: DataSource = {
                source: 'external',
                external: {
                    dialect: 'sqlite',
                    provider: 'turso',
                    uri: 'libsql://turso.io',
                    token: 'turso-token',
                },
                rpc: {} as any,
            }

            const result = await executeSDKQuery({
                sql: 'SELECT * FROM turso_table',
                dataSource: ds,
                config: mockConfig,
            })

            expect(mockConnect).toHaveBeenCalled()
            expect(result).toEqual([{ id: 1, name: 'SDK-Result' }])
        })

        it('should throw error for unsupported external database type', async () => {
            const ds: DataSource = {
                source: 'external',
                external: {
                    dialect: 'oracle' as any,
                },
                rpc: {} as any,
            }

            await expect(
                executeSDKQuery({
                    sql: 'SELECT 1',
                    dataSource: ds,
                    config: mockConfig,
                })
            ).rejects.toThrow('Unsupported external database type')
        })
    })
})
