import { describe, it, expect, vi, beforeEach } from 'vitest'
import { isQueryAllowed } from './index'

// Mock node-sql-parser since it might not be available in the test environment easily
vi.mock('node-sql-parser', () => {
    return {
        Parser: vi.fn().mockImplementation(() => ({
            astify: vi.fn().mockImplementation((sql: string) => ({ type: 'select', sql })),
        })),
    }
})

describe('Allowlist', () => {
    let mockDataSource: any
    let mockConfig: any

    beforeEach(() => {
        vi.clearAllMocks()
        mockDataSource = {
            source: 'internal',
            rpc: {
                executeQuery: vi.fn(),
            },
        }
        mockConfig = {
            role: 'client',
        }
    })

    it('should return true if allowlist is disabled', async () => {
        const result = await isQueryAllowed({
            sql: 'SELECT * FROM users',
            isEnabled: false,
            dataSource: mockDataSource,
            config: mockConfig,
        })
        expect(result).toBe(true)
    })

    it('should return true if user is admin', async () => {
        mockConfig.role = 'admin'
        const result = await isQueryAllowed({
            sql: 'SELECT * FROM users',
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })
        expect(result).toBe(true)
    })

    it('should allow queries in the allowlist', async () => {
        mockDataSource.rpc.executeQuery.mockResolvedValueOnce([
            { sql_statement: 'SELECT * FROM users', source: 'internal' },
        ])

        const result = await isQueryAllowed({
            sql: 'SELECT * FROM users',
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(result).toBe(true)
        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledWith(
            expect.objectContaining({ sql: expect.stringContaining('tmp_allowlist_queries') })
        )
    })

    it('should reject queries not in the allowlist and record them', async () => {
        mockDataSource.rpc.executeQuery
            .mockResolvedValueOnce([]) // loadAllowlist returns empty
            .mockResolvedValueOnce([]) // addRejectedQuery returns empty

        await expect(
            isQueryAllowed({
                sql: 'DROP TABLE users',
                isEnabled: true,
                dataSource: mockDataSource,
                config: mockConfig,
            })
        ).rejects.toThrow('Query not allowed')

        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledTimes(2)
        expect(mockDataSource.rpc.executeQuery).toHaveBeenLastCalledWith(
            expect.objectContaining({
                sql: expect.stringContaining('tmp_allowlist_rejections'),
                params: ['DROP TABLE users', 'internal'],
            })
        )
    })

    it('should throw error if no SQL is provided', async () => {
        mockDataSource.rpc.executeQuery.mockResolvedValueOnce([])

        await expect(
            isQueryAllowed({
                sql: '',
                isEnabled: true,
                dataSource: mockDataSource,
                config: mockConfig,
            })
        ).rejects.toThrow('No SQL provided for allowlist check')
    })
})
