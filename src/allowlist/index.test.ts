import { describe, it, expect, vi, beforeEach } from 'vitest'
import { isQueryAllowed } from './index'
import { DataSource } from '../types'
import { StarbaseDBConfiguration } from '../handler'

describe('allowlist', () => {
    let mockDataSource: DataSource
    let mockConfig: StarbaseDBConfiguration

    beforeEach(() => {
        mockDataSource = {
            source: 'test-source',
            type: 'sqlite',
            config: {},
            rpc: {
                executeQuery: vi.fn(),
                executeExternalQuery: vi.fn(),
            },
        } as unknown as DataSource

        mockConfig = {
            role: 'user',
            api: {
                enabled: true,
            },
        } as unknown as StarbaseDBConfiguration
    })

    it('allows query if allowlist feature is disabled', async () => {
        const result = await isQueryAllowed({
            sql: 'SELECT * FROM users',
            isEnabled: false,
            dataSource: mockDataSource,
            config: mockConfig,
        })
        expect(result).toBe(true)
        expect(mockDataSource.rpc.executeQuery).not.toHaveBeenCalled()
    })

    it('allows query if role is admin', async () => {
        mockConfig.role = 'admin'
        const result = await isQueryAllowed({
            sql: 'SELECT * FROM users',
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })
        expect(result).toBe(true)
        expect(mockDataSource.rpc.executeQuery).not.toHaveBeenCalled()
    })

    it('rejects empty query', async () => {
        mockDataSource.rpc.executeQuery = vi.fn().mockResolvedValue([])

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

    it('allows a query that exactly matches the allowlist', async () => {
        mockDataSource.rpc.executeQuery = vi
            .fn()
            .mockResolvedValue([
                { sql_statement: 'SELECT * FROM users', source: 'test-source' },
            ])

        const result = await isQueryAllowed({
            sql: 'SELECT * FROM users;', // with semicolon
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })
        expect(result).toBe(true)
    })

    it('rejects a query that is not in the allowlist and logs rejection', async () => {
        mockDataSource.rpc.executeQuery = vi
            .fn()
            // First call for loadAllowlist
            .mockResolvedValueOnce([
                {
                    sql_statement: 'SELECT * FROM valid_table',
                    source: 'test-source',
                },
            ])
            // Second call for addRejectedQuery
            .mockResolvedValueOnce([])

        await expect(
            isQueryAllowed({
                sql: 'SELECT * FROM invalid_table',
                isEnabled: true,
                dataSource: mockDataSource,
                config: mockConfig,
            })
        ).rejects.toThrow('Query not allowed')

        // Verify that addRejectedQuery was called
        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledTimes(2)
        expect(mockDataSource.rpc.executeQuery).toHaveBeenNthCalledWith(2, {
            sql: 'INSERT INTO tmp_allowlist_rejections (sql_statement, source) VALUES (?, ?)',
            params: ['SELECT * FROM invalid_table', 'test-source'],
        })
    })

    it('handles query execution error when loading allowlist', async () => {
        mockDataSource.rpc.executeQuery = vi
            .fn()
            .mockRejectedValue(new Error('DB error'))

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
