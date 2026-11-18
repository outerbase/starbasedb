import { describe, it, expect, vi, beforeEach } from 'vitest'
import { isQueryAllowed } from './index'
import type { DataSource } from '../types'
import type { StarbaseDBConfiguration } from '../handler'

describe('Allowlist Module (isQueryAllowed)', () => {
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
            role: 'client',
            features: { allowlist: true },
        }
    })

    it('should allow any query when allowlist feature is disabled', async () => {
        const result = await isQueryAllowed({
            sql: 'SELECT * FROM users',
            isEnabled: false,
            dataSource: mockDataSource,
            config: mockConfig,
        })
        expect(result).toBe(true)
        expect(mockDataSource.rpc.executeQuery).not.toHaveBeenCalled()
    })

    it('should allow any query when user role is admin', async () => {
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

    it('should return an Error when SQL is empty', async () => {
        vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValue([])
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

    it('should allow query matching an allowlisted SQL statement (ignoring trailing semicolon)', async () => {
        vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValue([
            { sql_statement: 'SELECT * FROM users', source: 'internal' },
            { sql_statement: 'SELECT * FROM other', source: 'external' },
        ])

        const result = await isQueryAllowed({
            sql: 'SELECT * FROM users;',
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })
        expect(result).toBe(true)
    })

    it('should reject query not in allowlist and log rejection', async () => {
        vi.mocked(mockDataSource.rpc.executeQuery)
            .mockResolvedValueOnce([
                {
                    sql_statement: 'SELECT id FROM users WHERE active = 1',
                    source: 'internal',
                },
            ])
            .mockResolvedValueOnce([])

        await expect(
            isQueryAllowed({
                sql: 'SELECT * FROM users WHERE id = 1',
                isEnabled: true,
                dataSource: mockDataSource,
                config: mockConfig,
            })
        ).rejects.toThrow('Query not allowed')

        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledTimes(2)
    })

    it('should reject when allowlist has different AST structure or array lengths', async () => {
        vi.mocked(mockDataSource.rpc.executeQuery)
            .mockResolvedValueOnce([
                {
                    sql_statement: 'SELECT id, name FROM users',
                    source: 'internal',
                },
            ])
            .mockRejectedValueOnce(new Error('Rejection insert failed'))

        vi.spyOn(console, 'error').mockImplementation(() => {})

        await expect(
            isQueryAllowed({
                sql: 'SELECT id FROM users',
                isEnabled: true,
                dataSource: mockDataSource,
                config: mockConfig,
            })
        ).rejects.toThrow('Query not allowed')
    })

    it('should handle loadAllowlist DB errors gracefully and reject query', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        vi.mocked(mockDataSource.rpc.executeQuery).mockRejectedValue(
            new Error('DB connection error')
        )

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
