import { describe, it, expect, vi, beforeEach } from 'vitest'
import { isQueryAllowed } from './index'
import type { DataSource } from '../types'
import type { StarbaseDBConfiguration } from '../handler'

let mockDataSource: DataSource
let mockConfig: StarbaseDBConfiguration

beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})

    mockDataSource = {
        source: 'internal',
        rpc: {
            executeQuery: vi.fn().mockResolvedValue([
                {
                    sql_statement: 'SELECT * FROM users WHERE id = 1',
                    source: 'internal',
                },
            ]),
        },
    } as any

    mockConfig = {
        outerbaseApiKey: 'mock-api-key',
        role: 'client',
        features: { allowlist: true, rls: true, rest: true },
    }
})

describe('isQueryAllowed', () => {
    it('allows every query when the feature is disabled', async () => {
        const allowed = await isQueryAllowed({
            sql: 'DROP TABLE users',
            isEnabled: false,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(allowed).toBe(true)
        expect(mockDataSource.rpc.executeQuery).not.toHaveBeenCalled()
    })

    it('allows every query for admin roles', async () => {
        mockConfig.role = 'admin'

        const allowed = await isQueryAllowed({
            sql: 'DELETE FROM users',
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(allowed).toBe(true)
        expect(mockDataSource.rpc.executeQuery).not.toHaveBeenCalled()
    })

    it('allows an explicitly listed query, including a trailing semicolon', async () => {
        const allowed = await isQueryAllowed({
            sql: 'SELECT * FROM users WHERE id = 1;',
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(allowed).toBe(true)
    })

    it('rejects a real-looking query that is not on the allowlist', async () => {
        await expect(
            isQueryAllowed({
                sql: 'SELECT * FROM orders WHERE id = 1',
                isEnabled: true,
                dataSource: mockDataSource,
                config: mockConfig,
            })
        ).rejects.toThrow('Query not allowed')

        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: 'INSERT INTO tmp_allowlist_rejections (sql_statement, source) VALUES (?, ?)',
            params: ['SELECT * FROM orders WHERE id = 1', 'internal'],
        })
    })

    it('rejects a fake table that is not on the allowlist', async () => {
        await expect(
            isQueryAllowed({
                sql: 'SELECT * FROM not_a_real_table',
                isEnabled: true,
                dataSource: mockDataSource,
                config: mockConfig,
            })
        ).rejects.toThrow('Query not allowed')
    })

    it('returns an Error object when SQL is omitted', async () => {
        const result = await isQueryAllowed({
            sql: '',
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(result).toBeInstanceOf(Error)
        expect((result as Error).message).toBe(
            'No SQL provided for allowlist check'
        )
    })

    it('rejects null-like SQL values that cannot be parsed', async () => {
        await expect(
            isQueryAllowed({
                sql: 'null',
                isEnabled: true,
                dataSource: mockDataSource,
                config: mockConfig,
            })
        ).rejects.toThrow()
    })

    it('does not treat different literal values as the same statement', async () => {
        await expect(
            isQueryAllowed({
                sql: 'SELECT * FROM users WHERE id = 2',
                isEnabled: true,
                dataSource: mockDataSource,
                config: mockConfig,
            })
        ).rejects.toThrow('Query not allowed')
    })

    it('filters allowlist rows by data source', async () => {
        vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValue([
            {
                sql_statement: 'SELECT * FROM users WHERE id = 1',
                source: 'external',
            },
        ] as any)

        await expect(
            isQueryAllowed({
                sql: 'SELECT * FROM users WHERE id = 1',
                isEnabled: true,
                dataSource: mockDataSource,
                config: mockConfig,
            })
        ).rejects.toThrow('Query not allowed')
    })

    it('treats an empty allowlist as a rejection when loading fails', async () => {
        vi.mocked(mockDataSource.rpc.executeQuery).mockRejectedValue(
            new Error('tmp_allowlist_queries missing')
        )

        await expect(
            isQueryAllowed({
                sql: 'SELECT * FROM users WHERE id = 1',
                isEnabled: true,
                dataSource: mockDataSource,
                config: mockConfig,
            })
        ).rejects.toThrow('Query not allowed')
    })

    it('still rejects the query if recording the rejection fails', async () => {
        vi.mocked(mockDataSource.rpc.executeQuery)
            .mockResolvedValueOnce([
                {
                    sql_statement: 'SELECT 1',
                    source: 'internal',
                },
            ] as any)
            .mockRejectedValueOnce(new Error('insert failed'))

        await expect(
            isQueryAllowed({
                sql: 'SELECT * FROM users',
                isEnabled: true,
                dataSource: mockDataSource,
                config: mockConfig,
            })
        ).rejects.toThrow('Query not allowed')
    })
})
