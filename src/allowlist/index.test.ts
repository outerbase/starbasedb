import { describe, it, expect, vi, beforeEach } from 'vitest'
import { isQueryAllowed } from './index'
import type { DataSource } from '../types'
import type { StarbaseDBConfiguration } from '../handler'

let mockDataSource: DataSource
let mockConfig: StarbaseDBConfiguration

beforeEach(() => {
    vi.clearAllMocks()

    mockDataSource = {
        source: 'external',
        external: { dialect: 'sqlite' },
        rpc: {
            executeQuery: vi.fn(),
        },
    } as any

    mockConfig = {
        outerbaseApiKey: 'mock-api-key',
        role: 'user',
        features: { allowlist: true, rls: true, rest: true },
    }
})

describe('Allowlist Module (isQueryAllowed)', () => {
    it('should return true when allowlist is not enabled', async () => {
        const result = await isQueryAllowed({
            sql: 'SELECT * FROM secret_table',
            isEnabled: false,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(result).toBe(true)
        expect(mockDataSource.rpc.executeQuery).not.toHaveBeenCalled()
    })

    it('should return true when user role is admin regardless of allowlist', async () => {
        const adminConfig: StarbaseDBConfiguration = {
            ...mockConfig,
            role: 'admin',
        }

        const result = await isQueryAllowed({
            sql: 'DROP TABLE important_table',
            isEnabled: true,
            dataSource: mockDataSource,
            config: adminConfig,
        })

        expect(result).toBe(true)
        expect(mockDataSource.rpc.executeQuery).not.toHaveBeenCalled()
    })

    it('should return an Error if no SQL string is provided', async () => {
        // Mock loadAllowlist query return
        vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValueOnce([])

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

    it('should allow queries matching the loaded allowlist AST', async () => {
        vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValueOnce([
            {
                sql_statement: 'SELECT id, name FROM users WHERE id = 1',
                source: 'external',
            },
        ])

        const result = await isQueryAllowed({
            sql: 'SELECT id, name FROM users WHERE id = 1;',
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(result).toBe(true)
        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledTimes(1)
        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: 'SELECT sql_statement, source FROM tmp_allowlist_queries WHERE source="external"',
        })
    })

    it('should reject queries not in allowlist and record rejection audit log', async () => {
        // 1st call: loadAllowlist
        vi.mocked(mockDataSource.rpc.executeQuery)
            .mockResolvedValueOnce([
                {
                    sql_statement: 'SELECT id FROM users',
                    source: 'external',
                },
            ])
            // 2nd call: addRejectedQuery
            .mockResolvedValueOnce([])

        await expect(
            isQueryAllowed({
                sql: 'DELETE FROM users WHERE id = 99',
                isEnabled: true,
                dataSource: mockDataSource,
                config: mockConfig,
            })
        ).rejects.toThrow('Query not allowed')

        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledTimes(2)
        expect(mockDataSource.rpc.executeQuery).toHaveBeenNthCalledWith(2, {
            sql: 'INSERT INTO tmp_allowlist_rejections (sql_statement, source) VALUES (?, ?)',
            params: ['DELETE FROM users WHERE id = 99', 'external'],
        })
    })

    it('should handle trailing semicolon normalization equivalence', async () => {
        vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValueOnce([
            {
                sql_statement: 'SELECT * FROM products;',
                source: 'external',
            },
        ])

        const result = await isQueryAllowed({
            sql: 'SELECT * FROM products',
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(result).toBe(true)
    })

    it('should gracefully handle loadAllowlist failure by falling back to empty allowlist', async () => {
        vi.mocked(mockDataSource.rpc.executeQuery)
            .mockRejectedValueOnce(new Error('Connection failure'))
            .mockResolvedValueOnce([])

        await expect(
            isQueryAllowed({
                sql: 'SELECT * FROM items',
                isEnabled: true,
                dataSource: mockDataSource,
                config: mockConfig,
            })
        ).rejects.toThrow('Query not allowed')
    })
})
