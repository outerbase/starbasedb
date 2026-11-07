import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
    executeQuery,
    executeTransaction,
    executeExternalQuery,
} from './operation'
import { isQueryAllowed } from './allowlist'
import { applyRLS } from './rls'
import { beforeQueryCache, afterQueryCache } from './cache'
import type { DataSource } from './types'
import type { StarbaseDBConfiguration } from './handler'

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
    vi.mocked(afterQueryCache).mockResolvedValue(null)
    vi.clearAllMocks()
})

describe('executeQuery', () => {
    it('executes a valid SQL query and invokes allowlist and RLS checks', async () => {
        const result = await executeQuery({
            sql: 'SELECT * FROM users',
            params: undefined,
            isRaw: false,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(isQueryAllowed).toHaveBeenCalledWith(
            expect.objectContaining({
                sql: 'SELECT * FROM users',
                isEnabled: true,
            })
        )
        expect(applyRLS).toHaveBeenCalledWith(
            expect.objectContaining({ sql: 'SELECT * FROM users' })
        )
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

    it('disables allowlist verification when bypassAllowlist is true', async () => {
        await executeQuery({
            sql: 'PRAGMA table_info(users);',
            params: [],
            isRaw: false,
            dataSource: mockDataSource,
            config: mockConfig,
            bypassAllowlist: true,
        })

        expect(isQueryAllowed).toHaveBeenCalledWith(
            expect.objectContaining({
                sql: 'PRAGMA table_info(users);',
                isEnabled: false,
            })
        )
    })

    it('returns cached results when present and handles missing dataSource', async () => {
        vi.mocked(beforeQueryCache).mockResolvedValueOnce([
            { id: 99, name: 'Cached' },
        ] as any)

        const cachedResult = await executeQuery({
            sql: 'SELECT * FROM users',
            params: undefined,
            isRaw: false,
            dataSource: mockDataSource,
            config: mockConfig,
        })
        expect(cachedResult).toEqual([{ id: 99, name: 'Cached' }])
        expect(mockDataSource.rpc.executeQuery).not.toHaveBeenCalled()

        const emptyResult = await executeQuery({
            sql: 'SELECT * FROM users',
            params: undefined,
            isRaw: false,
            dataSource: null as any,
            config: mockConfig,
        })
        expect(emptyResult).toEqual([])
    })
})

describe('executeTransaction', () => {
    it('executes multiple queries and forwards bypassAllowlist flag', async () => {
        const queries = [
            { sql: 'INSERT INTO users VALUES (1, "Alice")' },
            { sql: 'INSERT INTO users VALUES (2, "Bob")' },
        ]

        await executeTransaction({
            queries,
            isRaw: false,
            dataSource: mockDataSource,
            config: mockConfig,
            bypassAllowlist: true,
        })

        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledTimes(2)
        expect(isQueryAllowed).toHaveBeenCalledWith(
            expect.objectContaining({ isEnabled: false })
        )
    })

    it('returns an empty array when dataSource is missing', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})

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
    it('throws an error when dataSource.external is missing', async () => {
        await expect(
            executeExternalQuery({
                sql: 'SELECT * FROM users',
                params: [],
                dataSource: { source: 'internal' } as any,
                config: mockConfig,
            })
        ).rejects.toThrow('External connection not found.')
    })

    it('formats SQL and positional parameters for Outerbase API requests', async () => {
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

    it('handles network failures and malformed Outerbase API responses', async () => {
        vi.spyOn(global, 'fetch').mockRejectedValueOnce(
            new Error('Network error')
        )

        await expect(
            executeExternalQuery({
                sql: 'SELECT * FROM users',
                params: [],
                dataSource: mockDataSource,
                config: mockConfig,
            })
        ).rejects.toThrow('Network error')

        vi.spyOn(global, 'fetch').mockResolvedValueOnce({
            json: async () => ({}),
        } as Response)

        const malformedResult = await executeExternalQuery({
            sql: 'SELECT * FROM users',
            params: [],
            dataSource: mockDataSource,
            config: mockConfig,
        })
        expect(malformedResult).toEqual([])
    })
})
