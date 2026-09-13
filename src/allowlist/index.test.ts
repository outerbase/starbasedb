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

describe('isQueryAllowed - Feature Flags & Roles', () => {
    it('should allow any query if allowlist is not enabled', async () => {
        const result = await isQueryAllowed({
            sql: 'DROP TABLE users;',
            isEnabled: false,
            dataSource: mockDataSource,
            config: mockConfig,
        })
        expect(result).toBe(true)
        expect(mockDataSource.rpc.executeQuery).not.toHaveBeenCalled()
    })

    it('should allow any query if role is admin', async () => {
        mockConfig.role = 'admin'
        const result = await isQueryAllowed({
            sql: 'DROP TABLE users;',
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })
        expect(result).toBe(true)
        expect(mockDataSource.rpc.executeQuery).not.toHaveBeenCalled()
    })

    it('should return error if sql is empty', async () => {
        vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValue([])
        const result = await isQueryAllowed({
            sql: '',
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })
        expect(result).toBeInstanceOf(Error)
        expect((result as Error).message).toBe('No SQL provided for allowlist check')
    })
})

describe('isQueryAllowed - Query Matching & Rejection', () => {
    it('should allow query that matches allowlist AST (ignoring trailing semicolon)', async () => {
        vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValueOnce([
            {
                sql_statement: 'SELECT id, name FROM users WHERE id = 1;',
                source: 'internal',
            },
        ] as any)

        const result = await isQueryAllowed({
            sql: 'SELECT id, name FROM users WHERE id = 1',
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(result).toBe(true)
        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledTimes(1)
    })

    it('should reject query not in allowlist and record rejected query', async () => {
        vi.mocked(mockDataSource.rpc.executeQuery)
            .mockResolvedValueOnce([
                {
                    sql_statement: 'SELECT id FROM users;',
                    source: 'internal',
                },
            ] as any)
            .mockResolvedValueOnce([] as any) // for addRejectedQuery

        await expect(
            isQueryAllowed({
                sql: 'SELECT * FROM users;',
                isEnabled: true,
                dataSource: mockDataSource,
                config: mockConfig,
            })
        ).rejects.toThrow('Query not allowed')

        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledTimes(2)
        expect(mockDataSource.rpc.executeQuery).toHaveBeenLastCalledWith({
            sql: 'INSERT INTO tmp_allowlist_rejections (sql_statement, source) VALUES (?, ?)',
            params: ['SELECT * FROM users;', 'internal'],
        })
    })

    it('should handle AST mismatch with different structure, array length, or keys', async () => {
        vi.mocked(mockDataSource.rpc.executeQuery)
            .mockResolvedValueOnce([
                {
                    sql_statement: 'SELECT a, b, c FROM tbl;',
                    source: 'internal',
                },
            ] as any)
            .mockResolvedValueOnce([] as any)

        await expect(
            isQueryAllowed({
                sql: 'SELECT a, b FROM tbl;',
                isEnabled: true,
                dataSource: mockDataSource,
                config: mockConfig,
            })
        ).rejects.toThrow('Query not allowed')
    })
})

describe('isQueryAllowed - Error Handling Resilience', () => {
    it('should handle loadAllowlist DB error gracefully and reject query', async () => {
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        vi.mocked(mockDataSource.rpc.executeQuery).mockRejectedValueOnce(
            new Error('DB Connection lost')
        )

        await expect(
            isQueryAllowed({
                sql: 'SELECT 1;',
                isEnabled: true,
                dataSource: mockDataSource,
                config: mockConfig,
            })
        ).rejects.toThrow('Query not allowed')

        consoleErrorSpy.mockRestore()
    })

    it('should handle addRejectedQuery failure gracefully', async () => {
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        vi.mocked(mockDataSource.rpc.executeQuery)
            .mockResolvedValueOnce([]) // empty allowlist
            .mockRejectedValueOnce(new Error('Cannot insert rejection'))

        await expect(
            isQueryAllowed({
                sql: 'SELECT 1;',
                isEnabled: true,
                dataSource: mockDataSource,
                config: mockConfig,
            })
        ).rejects.toThrow('Query not allowed')

        consoleErrorSpy.mockRestore()
    })

    it('should throw error when SQL parsing fails', async () => {
        vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValueOnce([])
        await expect(
            isQueryAllowed({
                sql: 'INVALID SQL STATEMENT @@@@',
                isEnabled: true,
                dataSource: mockDataSource,
                config: mockConfig,
            })
        ).rejects.toThrow()
    })
})
