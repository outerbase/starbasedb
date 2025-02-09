import { describe, it, expect, vi, beforeEach } from 'vitest'
import { isQueryAllowed } from './index' // Adjust the path if needed
import { DataSource } from '../types'
import { StarbaseDBConfiguration } from '../handler'

vi.mock('node-sql-parser', () => ({
    Parser: class {
        astify = vi.fn((sql) => sql) // Mock AST transformation as identity function
    },
}))

let mockDataSource: DataSource
let mockConfig: StarbaseDBConfiguration

beforeEach(() => {
    vi.clearAllMocks()

    mockDataSource = {
        source: 'external',
        rpc: {
            executeQuery: vi.fn(),
        },
    } as any

    mockConfig = {
        outerbaseApiKey: 'mock-api-key',
        role: 'client',
        features: { allowlist: true, rls: true, rest: true },
    }
})

describe('isQueryAllowed', () => {
    it('should allow queries if allowlist is disabled', async () => {
        const result = await isQueryAllowed({
            sql: 'SELECT * FROM users',
            isEnabled: false,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(result).toBe(true)
    })

    it('should allow queries for admin users', async () => {
        mockConfig.role = 'admin'

        const result = await isQueryAllowed({
            sql: 'SELECT * FROM users',
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(result).toBe(true)
    })

    it('should reject queries if not in allowlist', async () => {
        vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValueOnce([])

        await expect(
            isQueryAllowed({
                sql: 'SELECT * FROM users',
                isEnabled: true,
                dataSource: mockDataSource,
                config: mockConfig,
            })
        ).rejects.toThrow('Query not allowed')

        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledTimes(1)
    })

    it('should allow queries that are present in the allowlist', async () => {
        vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValueOnce([
            { sql_statement: 'SELECT * FROM users', source: 'external' },
        ])

        const result = await isQueryAllowed({
            sql: 'SELECT * FROM users',
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(result).toBe(true)
    })

    it('should return an error if no SQL is provided', async () => {
        await expect(
            isQueryAllowed({
                sql: '',
                isEnabled: true,
                dataSource: mockDataSource,
                config: mockConfig,
            })
        ).rejects.toThrow('No SQL provided for allowlist check')
    })

    it('should handle database errors gracefully', async () => {
        vi.mocked(mockDataSource.rpc.executeQuery).mockRejectedValue(
            new Error('Database Error')
        )

        await expect(
            isQueryAllowed({
                sql: 'SELECT * FROM users',
                isEnabled: true,
                dataSource: mockDataSource,
                config: mockConfig,
            })
        ).rejects.toThrow('Database Error')
    })

    it('should add rejected queries to the rejection table', async () => {
        vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValueOnce([])

        await expect(
            isQueryAllowed({
                sql: 'SELECT * FROM users',
                isEnabled: true,
                dataSource: mockDataSource,
                config: mockConfig,
            })
        ).rejects.toThrow('Query not allowed')

        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledTimes(2) // Once for allowlist, once for rejection
        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: 'INSERT INTO tmp_allowlist_rejections (sql_statement, source) VALUES (?, ?)',
            params: ['SELECT * FROM users', 'external'],
        })
    })
})
