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

vi.mock('./operation', async (importOriginal) => {
    const original = await importOriginal<typeof import('./operation')>()
    return {
        ...original,
        executeSDKQuery: vi
            .fn()
            .mockResolvedValue([{ id: 1, name: 'SDK-Result' }]),
    }
})

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
            host: 'mock-host',
            port: 5432,
            user: 'mock-user',
            password: 'mock-password',
            database: 'mock-db',
        },
        rpc: {
            executeQuery: vi.fn().mockResolvedValue([
                { id: 1, name: 'Alice' },
                { id: 2, name: 'Bob' },
            ]),
        },
    } as any

    vi.mocked(beforeQueryCache).mockResolvedValue(null)
    vi.mocked(afterQueryCache).mockResolvedValue(null)

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
