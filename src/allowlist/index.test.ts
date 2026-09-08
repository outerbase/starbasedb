import { describe, it, expect, vi, beforeEach } from 'vitest'
import { isQueryAllowed } from './index'
import type { DataSource } from '../types'
import type { StarbaseDBConfiguration } from '../handler'

let mockDataSource: DataSource

function createConfig(
    overrides: Partial<StarbaseDBConfiguration> = {}
): StarbaseDBConfiguration {
    return {
        outerbaseApiKey: 'mock-api-key',
        role: 'user',
        features: { allowlist: true, rls: true, rest: true },
        ...overrides,
    }
}

beforeEach(() => {
    vi.clearAllMocks()

    mockDataSource = {
        source: 'external',
        external: { dialect: 'sqlite' },
        rpc: { executeQuery: vi.fn() },
    } as any
})

describe('Allowlist Module', () => {
    it('allows any query when the allowlist feature is disabled', async () => {
        const result = await isQueryAllowed({
            sql: 'DROP TABLE users',
            isEnabled: false,
            dataSource: mockDataSource,
            config: createConfig(),
        })

        expect(result).toBe(true)
        expect(mockDataSource.rpc.executeQuery).not.toHaveBeenCalled()
    })

    it('allows any query for the admin role', async () => {
        const result = await isQueryAllowed({
            sql: 'DROP TABLE users',
            isEnabled: true,
            dataSource: mockDataSource,
            config: createConfig({ role: 'admin' }),
        })

        expect(result).toBe(true)
        expect(mockDataSource.rpc.executeQuery).not.toHaveBeenCalled()
    })

    it('allows a query whose AST matches an allowlist entry', async () => {
        ;(mockDataSource.rpc.executeQuery as any).mockResolvedValue([
            { sql_statement: 'SELECT * FROM users', source: 'external' },
        ])

        const result = await isQueryAllowed({
            sql: 'SELECT * FROM users',
            isEnabled: true,
            dataSource: mockDataSource,
            config: createConfig(),
        })

        expect(result).toBe(true)
    })

    it('treats a trailing semicolon as equivalent to the allowlist entry', async () => {
        ;(mockDataSource.rpc.executeQuery as any).mockResolvedValue([
            { sql_statement: 'SELECT * FROM users;', source: 'external' },
        ])

        const result = await isQueryAllowed({
            sql: 'SELECT * FROM users',
            isEnabled: true,
            dataSource: mockDataSource,
            config: createConfig(),
        })

        expect(result).toBe(true)
    })

    it('ignores allowlist rows from other sources', async () => {
        ;(mockDataSource.rpc.executeQuery as any).mockResolvedValue([
            { sql_statement: 'SELECT * FROM users', source: 'other-source' },
        ])

        await expect(
            isQueryAllowed({
                sql: 'SELECT * FROM users',
                isEnabled: true,
                dataSource: mockDataSource,
                config: createConfig(),
            })
        ).rejects.toThrow('Query not allowed')
    })

    it('rejects and records queries that are not on the allowlist', async () => {
        ;(mockDataSource.rpc.executeQuery as any).mockResolvedValue([
            { sql_statement: 'SELECT * FROM users', source: 'external' },
        ])

        await expect(
            isQueryAllowed({
                sql: 'DELETE FROM users',
                isEnabled: true,
                dataSource: mockDataSource,
                config: createConfig(),
            })
        ).rejects.toThrow('Query not allowed')

        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledTimes(2)
        const insertCall = (mockDataSource.rpc.executeQuery as any).mock
            .calls[1][0]
        expect(insertCall.sql).toContain('INSERT INTO tmp_allowlist_rejections')
        expect(insertCall.params).toEqual(['DELETE FROM users', 'external'])
    })

    it('returns an Error object when no SQL is provided', async () => {
        ;(mockDataSource.rpc.executeQuery as any).mockResolvedValue([])

        const result = await isQueryAllowed({
            sql: '',
            isEnabled: true,
            dataSource: mockDataSource,
            config: createConfig(),
        })

        expect(result).toBeInstanceOf(Error)
        expect((result as Error).message).toBe(
            'No SQL provided for allowlist check'
        )
    })

    it('returns an empty allowlist when loading it fails', async () => {
        ;(mockDataSource.rpc.executeQuery as any).mockRejectedValue(
            new Error('db unavailable')
        )

        await expect(
            isQueryAllowed({
                sql: 'SELECT * FROM users',
                isEnabled: true,
                dataSource: mockDataSource,
                config: createConfig(),
            })
        ).rejects.toThrow('Query not allowed')
    })

    it('does not fail the request when recording a rejection fails', async () => {
        const executeQuery = mockDataSource.rpc.executeQuery as any
        executeQuery.mockImplementation(({ sql }: { sql: string }) => {
            if (sql.startsWith('SELECT sql_statement')) {
                return Promise.resolve([
                    {
                        sql_statement: 'SELECT * FROM users',
                        source: 'external',
                    },
                ])
            }
            return Promise.reject(new Error('insert failed'))
        })

        await expect(
            isQueryAllowed({
                sql: 'DELETE FROM users',
                isEnabled: true,
                dataSource: mockDataSource,
                config: createConfig(),
            })
        ).rejects.toThrow('Query not allowed')
    })

    it('rejects queries that partially match an allowlist entry', async () => {
        ;(mockDataSource.rpc.executeQuery as any).mockResolvedValue([
            {
                sql_statement: 'SELECT id, name FROM users WHERE id = 1',
                source: 'external',
            },
        ])

        await expect(
            isQueryAllowed({
                sql: 'SELECT id, name FROM users WHERE id = 2',
                isEnabled: true,
                dataSource: mockDataSource,
                config: createConfig(),
            })
        ).rejects.toThrow('Query not allowed')
    })

    it('rejects queries of a different statement type than the entry', async () => {
        ;(mockDataSource.rpc.executeQuery as any).mockResolvedValue([
            { sql_statement: 'SELECT * FROM users', source: 'external' },
        ])

        await expect(
            isQueryAllowed({
                sql: 'INSERT INTO users VALUES (1)',
                isEnabled: true,
                dataSource: mockDataSource,
                config: createConfig(),
            })
        ).rejects.toThrow('Query not allowed')
    })

    it('rethrows parser errors for invalid SQL', async () => {
        ;(mockDataSource.rpc.executeQuery as any).mockResolvedValue([])

        await expect(
            isQueryAllowed({
                sql: '((( not valid sql ))]',
                isEnabled: true,
                dataSource: mockDataSource,
                config: createConfig(),
            })
        ).rejects.toThrow()
    })
})
