import { describe, it, expect, vi, beforeEach } from 'vitest'
import postgres from 'postgres'
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
import type { SqlConnection } from '@outerbase/sdk/dist/connections/sql-base'

// const mockSqlConnection = vi.hoisted(() => ({
//     connect: vi.fn().mockResolvedValue(undefined),
//     raw: vi
//         .fn()
//         .mockResolvedValue({ data: [{ id: 1, name: 'SDK-Test-Result' }] }),
// })) as unknown as SqlConnection

// const mockConfig = vi.hoisted(() => ({
//     outerbaseApiKey: 'mock-api-key',
//     role: 'admin',
//     features: { allowlist: true, rls: true, rest: true },
// })) as StarbaseDBConfiguration

// const mockDataSource = vi.hoisted(() => ({
//     source: 'internal',
//     external: {
//         dialect: 'postgresql',
//         provider: 'postgresql',
//         host: 'mock-host',
//         port: 5432,
//         user: 'mock-user',
//         password: 'mock-password',
//         database: 'mock-db',
//     } as any,
//     rpc: {
//         executeQuery: vi.fn().mockResolvedValue([
//             { id: 1, name: 'Alice' },
//             { id: 2, name: 'Bob' },
//         ]),
//     },
// })) as unknown as DataSource

// vi.mock('./operation', async (importOriginal) => {
//     const actual = await importOriginal<typeof import('./operation')>()
//     return {
//         ...actual,
//         executeQuery: vi.fn().mockResolvedValue([
//             { id: 1, name: 'Mocked Alice' },
//             { id: 2, name: 'Mocked Bob' },
//         ]),
//         executeSDKQuery: vi
//             .fn()
//             .mockResolvedValue([{ id: 1, name: 'SDK-Result' }]),
//         createSDKPostgresConnection: vi
//             .fn()
//             .mockResolvedValue({ database: mockSqlConnection }),
//         createSDKMySQLConnection: vi
//             .fn()
//             .mockResolvedValue({ database: mockSqlConnection }),
//         createSDKCloudflareConnection: vi
//             .fn()
//             .mockResolvedValue({ database: mockSqlConnection }),
//         createSDKStarbaseConnection: vi
//             .fn()
//             .mockResolvedValue({ database: mockSqlConnection }),
//         createSDKTursoConnection: vi
//             .fn()
//             .mockResolvedValue({ database: mockSqlConnection }),
//     }
// })

// vi.mock('./operation', () => ({
//     executeSDKQuery: vi.fn().mockResolvedValue([{ id: 1, name: 'SDK-Result' }]),
// }))

// vi.mock('./operation', async (importOriginal) => {
//     const original = await importOriginal<typeof import('./operation')>()
//     return {
//         ...original,
//         executeSDKQuery: vi
//             .fn()
//             .mockResolvedValue([{ id: 1, name: 'SDK-Result' }]),
//     }
// })

const sdkMocks = vi.hoisted(() => {
    const connection = {
        connect: vi.fn().mockResolvedValue(undefined),
        raw: vi.fn().mockResolvedValue({ data: [{ id: 1, name: 'SDK' }] }),
    }
    return { connection }
})

const postgresMocks = vi.hoisted(() => {
    const sqlFn = {
        unsafe: vi.fn().mockResolvedValue([{ id: 7, name: 'Hyperdrive' }]),
        end: vi.fn().mockResolvedValue(undefined),
    }
    return {
        sqlFn,
        postgres: vi.fn(() => sqlFn),
    }
})

vi.mock('pg', () => ({ Client: vi.fn() }))
vi.mock('mysql2', () => ({ createConnection: vi.fn() }))
vi.mock('@libsql/client/web', () => ({ createClient: vi.fn() }))
vi.mock('postgres', () => ({ default: postgresMocks.postgres }))
vi.mock('@outerbase/sdk', () => ({
    PostgreSQLConnection: vi.fn(function PostgreSQLConnection() {
        return sdkMocks.connection
    }),
    MySQLConnection: vi.fn(function MySQLConnection() {
        return sdkMocks.connection
    }),
    CloudflareD1Connection: vi.fn(function CloudflareD1Connection() {
        return sdkMocks.connection
    }),
    StarbaseConnection: vi.fn(function StarbaseConnection() {
        return sdkMocks.connection
    }),
    TursoConnection: vi.fn(function TursoConnection() {
        return sdkMocks.connection
    }),
}))

vi.mock('./allowlist', () => ({ isQueryAllowed: vi.fn() }))
vi.mock('./rls', () => ({ applyRLS: vi.fn(async ({ sql }) => sql) }))
vi.mock('./cache', () => ({
    beforeQueryCache: vi.fn(async () => null),
    afterQueryCache: vi.fn(),
}))

let mockSqlConnection: SqlConnection
let mockDataSource: DataSource
let mockConfig: StarbaseDBConfiguration

beforeEach(() => {
    // mockSqlConnection = {
    //     connect: vi.fn().mockResolvedValue(undefined),
    //     raw: vi
    //         .fn()
    //         .mockResolvedValue({ data: [{ id: 1, name: 'SDK-Test-Result' }] }),
    // } as unknown as SqlConnection

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
    vi.mocked(afterQueryCache).mockResolvedValue(null)
    // vi.mock('./operation', () => ({
    //     createSDKPostgresConnection: vi
    //         .fn()
    //         .mockResolvedValue({ database: mockSqlConnection }),
    //     createSDKMySQLConnection: vi
    //         .fn()
    //         .mockResolvedValue({ database: mockSqlConnection }),
    //     createSDKCloudflareConnection: vi
    //         .fn()
    //         .mockResolvedValue({ database: mockSqlConnection }),
    //     createSDKStarbaseConnection: vi
    //         .fn()
    //         .mockResolvedValue({ database: mockSqlConnection }),
    //     createSDKTursoConnection: vi
    //         .fn()
    //         .mockResolvedValue({ database: mockSqlConnection }),
    // }))

    vi.clearAllMocks()
})
// beforeEach(() => {
//     vi.clearAllMocks()

//     vi.mocked(beforeQueryCache).mockResolvedValue(null)
//     vi.mocked(afterQueryCache).mockResolvedValue(null)
//     const mockExecuteQueryResult = [
//         { id: 1, name: 'Alice' },
//         { id: 2, name: 'Bob' },
//     ] as any
//     mockExecuteQueryResult[Symbol.dispose] = vi.fn()
//     vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValue(
//         mockExecuteQueryResult
//     )
// })
// vi.mock('./operation', async (importOriginal) => {
//     const original = await importOriginal<typeof import('./operation')>()
//     return {
//         ...original,
//         executeSDKQuery: vi
//             .fn()
//             .mockResolvedValue([{ id: 1, name: 'SDK-Result' }]),
//         createSDKPostgresConnection: vi
//             .fn()
//             .mockResolvedValue({ database: mockSqlConnection }),
//         createSDKMySQLConnection: vi
//             .fn()
//             .mockResolvedValue({ database: mockSqlConnection }),
//         createSDKCloudflareConnection: vi
//             .fn()
//             .mockResolvedValue({ database: mockSqlConnection }),
//         createSDKStarbaseConnection: vi
//             .fn()
//             .mockResolvedValue({ database: mockSqlConnection }),
//         createSDKTursoConnection: vi
//             .fn()
//             .mockResolvedValue({ database: mockSqlConnection }),
//     }
// })

// vi.mock('./operation', () => ({
//     createSDKPostgresConnection: vi
//         .fn()
//         .mockResolvedValue({ database: mockSqlConnection }),
//     createSDKMySQLConnection: vi
//         .fn()
//         .mockResolvedValue({ database: mockSqlConnection }),
//     createSDKCloudflareConnection: vi
//         .fn()
//         .mockResolvedValue({ database: mockSqlConnection }),
//     createSDKStarbaseConnection: vi
//         .fn()
//         .mockResolvedValue({ database: mockSqlConnection }),
//     createSDKTursoConnection: vi
//         .fn()
//         .mockResolvedValue({ database: mockSqlConnection }),
// }))

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
        const result = await executeQuery({
            sql: 'SELECT * FROM users',
            params: undefined,
            isRaw: false,
            dataSource: null as any,
            config: mockConfig,
        })
        expect(result).toEqual([])
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

    // it('should call executeSDKQuery if outerbaseApiKey is missing', async () => {
    //     const configWithoutApiKey = {
    //         ...mockConfig,
    //         outerbaseApiKey: undefined,
    //     }

    //     const result = await executeExternalQuery({
    //         sql: 'SELECT * FROM users',
    //         params: [],
    //         dataSource: {
    //             ...mockDataSource,
    //             external: {
    //                 dialect: 'postgresql',
    //                 host: 'mock-host',
    //                 port: 5432,
    //                 user: 'mock-user',
    //                 password: 'mock-password',
    //                 database: 'mock-db',
    //             } as any,
    //         },
    //         config: configWithoutApiKey,
    //     })

    //     expect(executeSDKQuery).toHaveBeenCalledWith({
    //         sql: 'SELECT * FROM users',
    //         params: [],
    //         dataSource: expect.objectContaining({
    //             external: expect.any(Object),
    //         }),

    //         config: configWithoutApiKey,
    //     })

    //     expect(result).toEqual([{ id: 1, name: 'SDK-Result' }])
    // })

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
            dataSource: {
                ...mockDataSource,
                external: {
                    dialect: 'postgresql',
                    host: 'mock-host',
                    port: 5432,
                    user: 'mock-user',
                    password: 'mock-password',
                    database: 'mock-db',
                },
            },
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

// describe('executeSDKQuery', () => {
//     it('should execute a query using PostgreSQL connection', async () => {
//         const result = await executeSDKQuery({
//             sql: 'SELECT * FROM users',
//             params: [],
//             dataSource: mockDataSource,
//             config: mockConfig,
//         })

//         expect(mockSqlConnection.connect).toHaveBeenCalled()
//         expect(mockSqlConnection.raw).toHaveBeenCalledWith(
//             'SELECT * FROM users',
//             []
//         )
//         expect(result).toEqual([{ id: 1, name: 'SDK-Test-Result' }])
//     })

//     it('should execute a query using MySQL connection', async () => {
//         if (mockDataSource.external) {
//             mockDataSource.external.dialect = 'mysql'
//         }

//         const result = await executeSDKQuery({
//             sql: 'SELECT * FROM users',
//             params: [],
//             dataSource: mockDataSource,
//             config: mockConfig,
//         })

//         expect(mockSqlConnection.connect).toHaveBeenCalled()
//         expect(mockSqlConnection.raw).toHaveBeenCalledWith(
//             'SELECT * FROM users',
//             []
//         )
//         expect(result).toEqual([{ id: 1, name: 'SDK-Test-Result' }])
//     })

//     it('should execute a query using Cloudflare D1 connection', async () => {
//         if (mockDataSource.external && 'provider' in mockDataSource.external) {
//             mockDataSource.external.provider = 'cloudflare-d1'
//         }
//         const result = await executeSDKQuery({
//             sql: 'SELECT * FROM users',
//             params: [],
//             dataSource: mockDataSource,
//             config: mockConfig,
//         })

//         expect(mockSqlConnection.connect).toHaveBeenCalled()
//         expect(mockSqlConnection.raw).toHaveBeenCalledWith(
//             'SELECT * FROM users',
//             []
//         )
//         expect(result).toEqual([{ id: 1, name: 'SDK-Test-Result' }])
//     })

//     it('should execute a query using Starbase connection', async () => {
//         if (mockDataSource.external && 'provider' in mockDataSource.external) {
//             mockDataSource.external.provider = 'starbase'
//         }

//         const result = await executeSDKQuery({
//             sql: 'SELECT * FROM users',
//             params: [],
//             dataSource: mockDataSource,
//             config: mockConfig,
//         })

//         expect(mockSqlConnection.connect).toHaveBeenCalled()
//         expect(mockSqlConnection.raw).toHaveBeenCalledWith(
//             'SELECT * FROM users',
//             []
//         )
//         expect(result).toEqual([{ id: 1, name: 'SDK-Test-Result' }])
//     })

//     it('should execute a query using Turso connection', async () => {
//         if (mockDataSource.external && 'provider' in mockDataSource.external) {
//             mockDataSource.external.provider = 'turso'
//         }

//         const result = await executeSDKQuery({
//             sql: 'SELECT * FROM users',
//             params: [],
//             dataSource: mockDataSource,
//             config: mockConfig,
//         })

//         expect(mockSqlConnection.connect).toHaveBeenCalled()
//         expect(mockSqlConnection.raw).toHaveBeenCalledWith(
//             'SELECT * FROM users',
//             []
//         )
//         expect(result).toEqual([{ id: 1, name: 'SDK-Test-Result' }])
//     })
//     it('should return an empty array if external connection is missing', async () => {
//         mockDataSource.external = undefined as any

//         const result = await executeSDKQuery({
//             sql: 'SELECT * FROM users',
//             params: [],
//             dataSource: mockDataSource,
//             config: mockConfig,
//         })

//         expect(result).toEqual([])
//     })

//     it('should handle database connection errors gracefully', async () => {
//         vi.mocked(mockSqlConnection.connect).mockRejectedValueOnce(
//             new Error('DB connection failed')
//         )

//         await expect(
//             executeSDKQuery({
//                 sql: 'SELECT * FROM users',
//                 params: [],
//                 dataSource: mockDataSource,
//                 config: mockConfig,
//             })
//         ).rejects.toThrow('DB connection failed')
//     })

//     it('should handle query execution errors gracefully', async () => {
//         vi.mocked(mockSqlConnection.raw).mockRejectedValueOnce(
//             new Error('Query execution failed')
//         )

//         await expect(
//             executeSDKQuery({
//                 sql: 'SELECT * FROM users',
//                 params: [],
//                 dataSource: mockDataSource,
//                 config: mockConfig,
//             })
//         ).rejects.toThrow('Query execution failed')
//     })
// })

describe('executeQuery additional paths', () => {
    it('returns an empty array when the durable object yields no result', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValueOnce(
            undefined as any
        )

        const result = await executeQuery({
            sql: 'SELECT * FROM users',
            params: undefined,
            isRaw: false,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(result).toEqual([])
    })

    it('skips cache reads for raw queries and reshapes the result', async () => {
        vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValueOnce([
            { id: 1, name: 'Ada' },
        ] as any)

        const result = await executeQuery({
            sql: 'SELECT * FROM users',
            params: undefined,
            isRaw: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(beforeQueryCache).not.toHaveBeenCalled()
        expect(result).toEqual({
            columns: ['id', 'name'],
            rows: [[1, 'Ada']],
            meta: { rows_read: 1, rows_written: 0 },
        })
    })

    it('runs plugin before/after query hooks and still caches the result', async () => {
        const registry = {
            beforeQuery: vi.fn(async ({ sql, params }: any) => ({
                sql: `${sql} -- hooked`,
                params,
            })),
            afterQuery: vi.fn(async ({ result }: any) => [
                ...result,
                { hooked: true },
            ]),
        }
        mockDataSource.registry = registry as any

        const result = await executeQuery({
            sql: 'SELECT * FROM users',
            params: undefined,
            isRaw: false,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(registry.beforeQuery).toHaveBeenCalled()
        expect(registry.afterQuery).toHaveBeenCalled()
        expect(afterQueryCache).toHaveBeenCalled()
        expect(result).toEqual([
            { id: 1, name: 'Alice' },
            { id: 2, name: 'Bob' },
            { hooked: true },
        ])
    })

    it('keeps the original result when an afterQuery hook throws', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        mockDataSource.registry = {
            beforeQuery: vi.fn(async ({ sql, params }: any) => ({
                sql,
                params,
            })),
            afterQuery: vi.fn(async () => {
                throw new Error('plugin crashed')
            }),
        } as any

        const result = await executeQuery({
            sql: 'SELECT * FROM users',
            params: undefined,
            isRaw: false,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(result).toEqual([
            { id: 1, name: 'Alice' },
            { id: 2, name: 'Bob' },
        ])
    })

    it('executes external queries through the Outerbase API path', async () => {
        mockDataSource.source = 'external'
        vi.spyOn(global, 'fetch').mockResolvedValueOnce({
            json: async () => ({
                response: { results: { items: [{ id: 3 }] } },
            }),
        } as Response)

        const result = await executeQuery({
            sql: 'SELECT * FROM users',
            params: undefined,
            isRaw: false,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(result).toEqual([{ id: 3 }])
    })

    it('executes hyperdrive queries and ends the pool via waitUntil', async () => {
        mockDataSource.source = 'hyperdrive'
        mockDataSource.external = {
            dialect: 'postgresql',
            connectionString: 'postgres://hyperdrive',
        } as any
        mockDataSource.executionContext = {
            waitUntil: vi.fn(),
        } as any

        const result = await executeQuery({
            sql: 'SELECT * FROM users',
            params: [1],
            isRaw: false,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(postgres).toHaveBeenCalled()
        expect(postgresMocks.sqlFn.unsafe).toHaveBeenCalled()
        expect(mockDataSource.executionContext.waitUntil).toHaveBeenCalled()
        expect(result).toEqual([{ id: 7, name: 'Hyperdrive' }])
    })

    it('ends the hyperdrive pool inline when no execution context exists', async () => {
        mockDataSource.source = 'hyperdrive'
        mockDataSource.external = {
            dialect: 'postgresql',
            connectionString: 'postgres://hyperdrive',
        } as any
        mockDataSource.executionContext = undefined

        await executeQuery({
            sql: 'SELECT * FROM users',
            params: undefined,
            isRaw: false,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(postgresMocks.sqlFn.end).toHaveBeenCalled()
    })

    it('throws when hyperdrive is missing a connection string', async () => {
        mockDataSource.source = 'hyperdrive'
        mockDataSource.external = { dialect: 'postgresql' } as any

        await expect(
            executeQuery({
                sql: 'SELECT * FROM users',
                params: undefined,
                isRaw: false,
                dataSource: mockDataSource,
                config: mockConfig,
            })
        ).rejects.toThrow('Hyperdrive connection string not found')
    })

    it('rethrows hyperdrive query errors', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        mockDataSource.source = 'hyperdrive'
        mockDataSource.external = {
            dialect: 'postgresql',
            connectionString: 'postgres://hyperdrive',
        } as any
        postgresMocks.sqlFn.unsafe.mockRejectedValueOnce(new Error('timeout'))

        await expect(
            executeQuery({
                sql: 'SELECT 1',
                params: undefined,
                isRaw: false,
                dataSource: mockDataSource,
                config: mockConfig,
            })
        ).rejects.toThrow('timeout')
    })
})

describe('executeSDKQuery', () => {
    const remoteSource = {
        dialect: 'postgresql',
        host: 'db',
        port: 5432,
        user: 'app',
        password: 'secret',
        database: 'appdb',
        defaultSchema: 'public',
    }

    it('returns an empty array when no external connection exists', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const result = await executeSDKQuery({
            sql: 'SELECT 1',
            params: [],
            dataSource: { source: 'external' } as any,
            config: mockConfig,
        })

        expect(result).toEqual([])
        expect(warn).toHaveBeenCalled()
    })

    it('connects through each supported SDK dialect and provider', async () => {
        const cases = [
            { dialect: 'postgresql', ...remoteSource },
            { dialect: 'mysql', ...remoteSource },
            {
                dialect: 'sqlite',
                provider: 'cloudflare-d1',
                apiKey: 'k',
                accountId: 'a',
                databaseId: 'd',
            },
            {
                dialect: 'sqlite',
                provider: 'starbase',
                apiKey: 'k',
                token: 't',
            },
            {
                dialect: 'sqlite',
                provider: 'turso',
                uri: 'libsql://db',
                token: 't',
            },
        ]

        for (const external of cases) {
            sdkMocks.connection.connect.mockClear()
            sdkMocks.connection.raw.mockClear()

            const result = await executeSDKQuery({
                sql: 'SELECT * FROM users',
                params: [1],
                dataSource: { source: 'external', external } as any,
                config: mockConfig,
            })

            expect(sdkMocks.connection.connect).toHaveBeenCalled()
            expect(sdkMocks.connection.raw).toHaveBeenCalledWith(
                'SELECT * FROM users',
                [1]
            )
            expect(result).toEqual([{ id: 1, name: 'SDK' }])
        }
    })

    it('throws for an unsupported external database type', async () => {
        await expect(
            executeSDKQuery({
                sql: 'SELECT 1',
                dataSource: {
                    source: 'external',
                    external: { dialect: 'sqlite', provider: 'mongo' },
                } as any,
                config: mockConfig,
            })
        ).rejects.toThrow('Unsupported external database type')
    })
})

describe('executeExternalQuery SDK fallback', () => {
    it('uses executeSDKQuery when no Outerbase API key is configured', async () => {
        const result = await executeExternalQuery({
            sql: 'SELECT * FROM users',
            params: [],
            dataSource: {
                source: 'external',
                external: {
                    dialect: 'postgresql',
                    host: 'db',
                    port: 5432,
                    user: 'app',
                    password: 'secret',
                    database: 'appdb',
                },
            } as any,
            config: { ...mockConfig, outerbaseApiKey: undefined },
        })

        expect(result).toEqual([{ id: 1, name: 'SDK' }])
    })

    it('forwards object params to the Outerbase API without rewriting placeholders', async () => {
        const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValueOnce({
            json: async () => ({
                response: { results: { items: [{ id: 8 }] } },
            }),
        } as Response)

        const result = await executeExternalQuery({
            sql: 'SELECT * FROM users\nWHERE id = :id',
            params: { id: 8 },
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(fetchMock).toHaveBeenCalledWith(
            'https://app.outerbase.com/api/v1/ezql/raw',
            expect.objectContaining({
                body: JSON.stringify({
                    query: 'SELECT * FROM users WHERE id = :id',
                    params: { id: 8 },
                }),
            })
        )
        expect(result).toEqual([{ id: 8 }])
    })
})
