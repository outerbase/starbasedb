import { describe, it, expect, vi, beforeEach } from 'vitest'
import { isQueryAllowed } from './index'
import { DataSource } from '../types'
import { StarbaseDBConfiguration } from '../handler'

describe('Allowlist - isQueryAllowed', () => {
    let mockDataSource: DataSource
    let clientConfig: StarbaseDBConfiguration

    beforeEach(() => {
        vi.restoreAllMocks()
        mockDataSource = {
            source: 'internal',
            rpc: {
                executeQuery: vi.fn(),
            },
        } as unknown as DataSource

        clientConfig = {
            role: 'client',
            features: { allowlist: true },
        }
    })

    it('should allow any query when allowlist feature is disabled', async () => {
        const result = await isQueryAllowed({
            sql: 'DROP TABLE users',
            isEnabled: false,
            dataSource: mockDataSource,
            config: clientConfig,
        })

        expect(result).toBe(true)
        expect(mockDataSource.rpc.executeQuery).not.toHaveBeenCalled()
    })

    it('should bypass allowlist checks for admin role', async () => {
        const result = await isQueryAllowed({
            sql: 'SELECT * FROM secrets',
            isEnabled: true,
            dataSource: mockDataSource,
            config: { role: 'admin', features: { allowlist: true } },
        })

        expect(result).toBe(true)
        expect(mockDataSource.rpc.executeQuery).not.toHaveBeenCalled()
    })

    it('should return an Error instance when SQL is empty', async () => {
        vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValue([])

        const result = await isQueryAllowed({
            sql: '',
            isEnabled: true,
            dataSource: mockDataSource,
            config: clientConfig,
        })

        expect(result).toBeInstanceOf(Error)
        expect((result as Error).message).toBe(
            'No SQL provided for allowlist check'
        )
    })

    it('should allow matching queries regardless of trailing semicolon or whitespace', async () => {
        vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValue([
            {
                sql_statement: 'SELECT id, name FROM users WHERE id = 1',
                source: 'internal',
            },
            {
                sql_statement: 'SELECT * FROM ignored_table',
                source: 'external',
            },
        ])

        const result = await isQueryAllowed({
            sql: '  SELECT id, name FROM users WHERE id = 1;  ',
            isEnabled: true,
            dataSource: mockDataSource,
            config: clientConfig,
        })

        expect(result).toBe(true)
    })

    it('should reject non-matching queries and record them in tmp_allowlist_rejections', async () => {
        vi.mocked(mockDataSource.rpc.executeQuery)
            .mockResolvedValueOnce([
                {
                    sql_statement: 'SELECT id FROM users',
                    source: 'internal',
                },
            ])
            .mockResolvedValueOnce([{ sql_statement: 'SELECT * FROM secrets' }])

        await expect(
            isQueryAllowed({
                sql: 'SELECT * FROM secrets',
                isEnabled: true,
                dataSource: mockDataSource,
                config: clientConfig,
            })
        ).rejects.toThrow('Query not allowed')

        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: 'INSERT INTO tmp_allowlist_rejections (sql_statement, source) VALUES (?, ?)',
            params: ['SELECT * FROM secrets', 'internal'],
        })
    })

    it('should reject when query AST differs in array length, object keys, or primitive values', async () => {
        vi.mocked(mockDataSource.rpc.executeQuery)
            .mockResolvedValueOnce([
                {
                    sql_statement: 'SELECT id, name FROM users WHERE id = 1',
                    source: 'internal',
                },
            ])
            .mockResolvedValueOnce([])

        await expect(
            isQueryAllowed({
                sql: 'SELECT id FROM users WHERE id = 1',
                isEnabled: true,
                dataSource: mockDataSource,
                config: clientConfig,
            })
        ).rejects.toThrow('Query not allowed')

        vi.mocked(mockDataSource.rpc.executeQuery)
            .mockResolvedValueOnce([
                {
                    sql_statement: 'SELECT id FROM users WHERE id = 1',
                    source: 'internal',
                },
            ])
            .mockResolvedValueOnce([])

        await expect(
            isQueryAllowed({
                sql: 'SELECT id FROM users WHERE id = 2',
                isEnabled: true,
                dataSource: mockDataSource,
                config: clientConfig,
            })
        ).rejects.toThrow('Query not allowed')
    })

    it('should handle errors when loading allowlist or recording rejections gracefully', async () => {
        const consoleErrorSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})
        vi.mocked(mockDataSource.rpc.executeQuery)
            .mockRejectedValueOnce(new Error('DB load failure'))
            .mockRejectedValueOnce(new Error('DB insert failure'))

        await expect(
            isQueryAllowed({
                sql: 'SELECT 1',
                isEnabled: true,
                dataSource: mockDataSource,
                config: clientConfig,
            })
        ).rejects.toThrow('Query not allowed')

        expect(consoleErrorSpy).toHaveBeenCalled()
    })

    it('should throw when invalid SQL fails parsing', async () => {
        vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValue([])

        await expect(
            isQueryAllowed({
                sql: 'NOT VALID SQL ???',
                isEnabled: true,
                dataSource: mockDataSource,
                config: clientConfig,
            })
        ).rejects.toThrow()
    })
})
