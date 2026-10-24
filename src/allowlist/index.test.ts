import { describe, it, expect, vi, beforeEach } from 'vitest'
import { isQueryAllowed } from './index'
import type { DataSource } from '../types'
import type { StarbaseDBConfiguration } from '../handler'

let mockDataSource: DataSource
let mockConfig: StarbaseDBConfiguration

beforeEach(() => {
    vi.clearAllMocks()

    mockDataSource = {
        source: 'internal',
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

describe('Allowlist Module (isQueryAllowed)', () => {
    it('should return true if allowlist is not enabled', async () => {
        const result = await isQueryAllowed({
            sql: 'SELECT * FROM users',
            isEnabled: false,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(result).toBe(true)
        expect(mockDataSource.rpc.executeQuery).not.toHaveBeenCalled()
    })

    it('should return true if role is admin', async () => {
        mockConfig.role = 'admin'

        const result = await isQueryAllowed({
            sql: 'DROP TABLE users',
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(result).toBe(true)
        expect(mockDataSource.rpc.executeQuery).not.toHaveBeenCalled()
    })

    it('should return error if sql is empty', async () => {
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

    it('should allow queries matching the allowlist AST structure', async () => {
        vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValueOnce([
            {
                sql_statement: 'SELECT id, name FROM users WHERE id = 1;',
                source: 'internal',
            },
        ])

        const result = await isQueryAllowed({
            sql: 'SELECT id, name FROM users WHERE id = 1',
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(result).toBe(true)
    })

    it('should reject unallowed queries and record rejection', async () => {
        vi.mocked(mockDataSource.rpc.executeQuery)
            // loadAllowlist
            .mockResolvedValueOnce([
                {
                    sql_statement: 'SELECT * FROM users;',
                    source: 'internal',
                },
            ])
            // addRejectedQuery
            .mockResolvedValueOnce([{ sql_statement: 'DELETE FROM users;' }])

        await expect(
            isQueryAllowed({
                sql: 'DELETE FROM users',
                isEnabled: true,
                dataSource: mockDataSource,
                config: mockConfig,
            })
        ).rejects.toThrow('Query not allowed')

        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: 'INSERT INTO tmp_allowlist_rejections (sql_statement, source) VALUES (?, ?)',
            params: ['DELETE FROM users', 'internal'],
        })
    })

    it('should handle loadAllowlist error gracefully and reject query', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        vi.mocked(mockDataSource.rpc.executeQuery)
            // loadAllowlist error
            .mockRejectedValueOnce(new Error('Connection failure'))
            // addRejectedQuery
            .mockResolvedValueOnce([])

        await expect(
            isQueryAllowed({
                sql: 'SELECT * FROM users',
                isEnabled: true,
                dataSource: mockDataSource,
                config: mockConfig,
            })
        ).rejects.toThrow('Query not allowed')
    })

    it('should handle addRejectedQuery error gracefully without crashing', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        vi.mocked(mockDataSource.rpc.executeQuery)
            // loadAllowlist returns empty
            .mockResolvedValueOnce([])
            // addRejectedQuery throws
            .mockRejectedValueOnce(new Error('Failed to insert rejection'))

        await expect(
            isQueryAllowed({
                sql: 'SELECT secret FROM confidential',
                isEnabled: true,
                dataSource: mockDataSource,
                config: mockConfig,
            })
        ).rejects.toThrow('Query not allowed')
    })
})
