import { describe, it, expect, vi, beforeEach } from 'vitest'
import { isQueryAllowed } from './index'
import { DataSource } from '../types'
import { StarbaseDBConfiguration } from '../handler'

describe('Query Allowlist Module (src/allowlist/index.ts)', () => {
    let mockExecuteQuery: ReturnType<typeof vi.fn>
    let mockDataSource: DataSource
    let mockConfig: StarbaseDBConfiguration

    beforeEach(() => {
        mockExecuteQuery = vi.fn()
        mockDataSource = {
            source: 'internal',
            rpc: {
                executeQuery: mockExecuteQuery,
            },
        } as unknown as DataSource

        mockConfig = {
            role: 'user',
        } as StarbaseDBConfiguration
    })

    describe('Feature Toggle & Administrative Bypass', () => {
        it('should return true immediately when allowlist is disabled (isEnabled: false)', async () => {
            const result = await isQueryAllowed({
                sql: 'DROP TABLE users;',
                isEnabled: false,
                dataSource: mockDataSource,
                config: mockConfig,
            })

            expect(result).toBe(true)
            expect(mockExecuteQuery).not.toHaveBeenCalled()
        })

        it('should bypass allowlist check and return true when config.role is admin', async () => {
            mockConfig.role = 'admin'

            const result = await isQueryAllowed({
                sql: 'SELECT * FROM sensitive_audit_logs;',
                isEnabled: true,
                dataSource: mockDataSource,
                config: mockConfig,
            })

            expect(result).toBe(true)
            expect(mockExecuteQuery).not.toHaveBeenCalled()
        })
    })

    describe('Validation & Edge Cases', () => {
        it('should return an Error object if no SQL is provided', async () => {
            mockExecuteQuery.mockResolvedValueOnce([])

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

        it('should gracefully handle loadAllowlist failure and reject queries', async () => {
            mockExecuteQuery.mockRejectedValueOnce(
                new Error('DB Connection Timeout')
            )
            // Second call for addRejectedQuery
            mockExecuteQuery.mockResolvedValueOnce([])

            await expect(
                isQueryAllowed({
                    sql: 'SELECT id FROM users;',
                    isEnabled: true,
                    dataSource: mockDataSource,
                    config: mockConfig,
                })
            ).rejects.toThrow('Query not allowed')
        })
    })

    describe('AST Matching & Query Normalization', () => {
        it('should allow a query that exactly matches an allowlisted query (ignoring trailing semicolon)', async () => {
            mockExecuteQuery.mockResolvedValueOnce([
                {
                    sql_statement: 'SELECT id, name FROM users',
                    source: 'internal',
                },
            ])

            const result = await isQueryAllowed({
                sql: 'SELECT id, name FROM users;',
                isEnabled: true,
                dataSource: mockDataSource,
                config: mockConfig,
            })

            expect(result).toBe(true)
            expect(mockExecuteQuery).toHaveBeenCalledTimes(1)
        })

        it('should allow queries matching the AST structure of allowlisted queries', async () => {
            mockExecuteQuery.mockResolvedValueOnce([
                {
                    sql_statement:
                        'SELECT id, email FROM accounts WHERE active = 1',
                    source: 'internal',
                },
            ])

            const result = await isQueryAllowed({
                sql: 'SELECT id, email FROM accounts WHERE active = 1',
                isEnabled: true,
                dataSource: mockDataSource,
                config: mockConfig,
            })

            expect(result).toBe(true)
        })

        it('should reject a query not matching the allowlist and log it to tmp_allowlist_rejections', async () => {
            mockExecuteQuery.mockResolvedValueOnce([
                {
                    sql_statement: 'SELECT id FROM users',
                    source: 'internal',
                },
            ])
            mockExecuteQuery.mockResolvedValueOnce([]) // for addRejectedQuery

            const unapprovedSql = 'DELETE FROM users WHERE id = 10'

            await expect(
                isQueryAllowed({
                    sql: unapprovedSql,
                    isEnabled: true,
                    dataSource: mockDataSource,
                    config: mockConfig,
                })
            ).rejects.toThrow('Query not allowed')

            // Verify rejected query was inserted into rejection audit table
            expect(mockExecuteQuery).toHaveBeenCalledTimes(2)
            expect(mockExecuteQuery).toHaveBeenLastCalledWith({
                sql: 'INSERT INTO tmp_allowlist_rejections (sql_statement, source) VALUES (?, ?)',
                params: [unapprovedSql, 'internal'],
            })
        })

        it('should handle addRejectedQuery database failure without crashing', async () => {
            mockExecuteQuery.mockResolvedValueOnce([]) // Empty allowlist
            mockExecuteQuery.mockRejectedValueOnce(new Error('Insert error'))

            await expect(
                isQueryAllowed({
                    sql: 'SELECT secret_token FROM tokens',
                    isEnabled: true,
                    dataSource: mockDataSource,
                    config: mockConfig,
                })
            ).rejects.toThrow('Query not allowed')
        })
    })
})
