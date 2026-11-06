import { describe, it, expect, vi, beforeEach } from 'vitest'
import { isQueryAllowed } from './index'
import type { DataSource } from '../types'
import type { StarbaseDBConfiguration } from '../handler'

describe('Allowlist Module - isQueryAllowed', () => {
    let mockDataSource: DataSource
    let mockConfig: StarbaseDBConfiguration

    beforeEach(() => {
        vi.clearAllMocks()

        mockDataSource = {
            source: 'internal',
            rpc: {
                executeQuery: vi.fn().mockResolvedValue([
                    {
                        sql_statement: 'SELECT id, name FROM users;',
                        source: 'internal',
                    },
                    {
                        sql_statement: 'SELECT * FROM orders WHERE id = 1',
                        source: 'external',
                    },
                ]),
            },
        } as unknown as DataSource

        mockConfig = {
            role: 'client',
            features: { allowlist: true },
        }
    })

    it('should return true immediately when allowlist is disabled', async () => {
        const res = await isQueryAllowed({
            sql: 'DROP TABLE users',
            isEnabled: false,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(res).toBe(true)
        expect(mockDataSource.rpc.executeQuery).not.toHaveBeenCalled()
    })

    it('should return true immediately when user role is admin', async () => {
        mockConfig.role = 'admin'

        const res = await isQueryAllowed({
            sql: 'DELETE FROM users',
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(res).toBe(true)
        expect(mockDataSource.rpc.executeQuery).not.toHaveBeenCalled()
    })

    it('should return Error when sql is empty string', async () => {
        const res = await isQueryAllowed({
            sql: '',
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(res).toBeInstanceOf(Error)
        expect((res as Error).message).toBe('No SQL provided for allowlist check')
    })

    it('should allow query that matches an allowlisted statement ignoring trailing semicolon', async () => {
        const res = await isQueryAllowed({
            sql: 'SELECT id, name FROM users',
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(res).toBe(true)
        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledTimes(1)
    })

    it('should reject query that is not in the allowlist and record it in tmp_allowlist_rejections', async () => {
        await expect(
            isQueryAllowed({
                sql: 'SELECT * FROM secret_table',
                isEnabled: true,
                dataSource: mockDataSource,
                config: mockConfig,
            })
        ).rejects.toThrow('Query not allowed')

        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: 'INSERT INTO tmp_allowlist_rejections (sql_statement, source) VALUES (?, ?)',
            params: ['SELECT * FROM secret_table', 'internal'],
        })
    })

    it('should handle errors when loading allowlist and reject non-matching query', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        vi.mocked(mockDataSource.rpc.executeQuery).mockRejectedValue(
            new Error('RPC failure')
        )

        await expect(
            isQueryAllowed({
                sql: 'SELECT id, name FROM users',
                isEnabled: true,
                dataSource: mockDataSource,
                config: mockConfig,
            })
        ).rejects.toThrow('Query not allowed')
    })
})
