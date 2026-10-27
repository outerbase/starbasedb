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
                executeQuery: vi.fn(),
            } as any,
        }

        mockConfig = {
            role: 'client',
            features: { allowlist: true },
        }
    })

    it('should return true when allowlist is disabled', async () => {
        await expect(
            isQueryAllowed({
                sql: 'SELECT * FROM users',
                isEnabled: false,
                dataSource: mockDataSource,
                config: mockConfig,
            })
        ).resolves.toBe(true)

        expect(mockDataSource.rpc.executeQuery).not.toHaveBeenCalled()
    })

    it('should return an Error object when sql is empty', async () => {
        vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValueOnce(
            [] as any
        )

        const res = await isQueryAllowed({
            sql: '',
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(res).toBeInstanceOf(Error)
        expect((res as Error).message).toBe(
            'No SQL provided for allowlist check'
        )
    })

    it('should bypass allowlist checks and return true when user role is admin', async () => {
        mockConfig.role = 'admin'

        await expect(
            isQueryAllowed({
                sql: 'DROP TABLE users',
                isEnabled: true,
                dataSource: mockDataSource,
                config: mockConfig,
            })
        ).resolves.toBe(true)

        expect(mockDataSource.rpc.executeQuery).not.toHaveBeenCalled()
    })

    it('should allow a query whose normalized AST matches an entry in tmp_allowlist_queries', async () => {
        vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValueOnce([
            {
                sql_statement: 'SELECT id, name FROM users WHERE id = 1;',
                source: 'internal',
            },
        ] as any)

        await expect(
            isQueryAllowed({
                sql: 'SELECT id, name FROM users WHERE id = 1',
                isEnabled: true,
                dataSource: mockDataSource,
                config: mockConfig,
            })
        ).resolves.toBe(true)

        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledTimes(1)
    })

    it('should reject an unauthorized query and insert a record into tmp_allowlist_rejections', async () => {
        vi.mocked(mockDataSource.rpc.executeQuery)
            .mockResolvedValueOnce([
                {
                    sql_statement: 'SELECT id FROM allowed_table',
                    source: 'internal',
                },
                {
                    sql_statement:
                        'SELECT id, name FROM allowed_table WHERE id = 1 AND status = 2',
                    source: 'internal',
                },
            ] as any)
            .mockResolvedValueOnce([
                { sql_statement: 'SELECT * FROM secret_table' },
            ] as any)

        await expect(
            isQueryAllowed({
                sql: 'SELECT * FROM secret_table',
                isEnabled: true,
                dataSource: mockDataSource,
                config: mockConfig,
            })
        ).rejects.toThrow('Query not allowed')

        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledTimes(2)
        expect(mockDataSource.rpc.executeQuery).toHaveBeenNthCalledWith(2, {
            sql: 'INSERT INTO tmp_allowlist_rejections (sql_statement, source) VALUES (?, ?)',
            params: ['SELECT * FROM secret_table', 'internal'],
        })
    })

    it('should compare array ASTs and mismatched object key counts accurately', async () => {
        vi.mocked(mockDataSource.rpc.executeQuery)
            .mockResolvedValueOnce([
                {
                    sql_statement: 'SELECT 1; SELECT 2; SELECT 3',
                    source: 'internal',
                },
                {
                    sql_statement: 'SELECT 1; SELECT 2',
                    source: 'internal',
                },
            ] as any)
            .mockResolvedValueOnce([] as any)

        await expect(
            isQueryAllowed({
                sql: 'SELECT 1; SELECT 2',
                isEnabled: true,
                dataSource: mockDataSource,
                config: mockConfig,
            })
        ).resolves.toBe(true)
    })

    it('should handle database errors in loadAllowlist and addRejectedQuery gracefully', async () => {
        const consoleErrorSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})

        vi.mocked(mockDataSource.rpc.executeQuery)
            .mockRejectedValueOnce(new Error('Load error'))
            .mockRejectedValueOnce(new Error('Insert rejection error'))

        await expect(
            isQueryAllowed({
                sql: 'SELECT * FROM users',
                isEnabled: true,
                dataSource: mockDataSource,
                config: mockConfig,
            })
        ).rejects.toThrow('Query not allowed')

        expect(consoleErrorSpy).toHaveBeenCalled()
        consoleErrorSpy.mockRestore()
    })
})
