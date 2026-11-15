import { describe, expect, it, vi } from 'vitest'
import { isQueryAllowed } from './index'
import { DataSource } from '../types'
import { StarbaseDBConfiguration } from '../handler'

describe('isQueryAllowed', () => {
    const mockDataSource: DataSource = {
        name: 'test-db',
        source: 'internal',
        type: 'sqlite',
        rpc: {
            executeQuery: vi.fn(),
        } as any,
    }

    const mockConfig: StarbaseDBConfiguration = {
        role: 'user',
    } as any

    it('should allow query when isEnabled is false', async () => {
        const result = await isQueryAllowed({
            sql: 'SELECT * FROM users',
            isEnabled: false,
            dataSource: mockDataSource,
            config: mockConfig,
        })
        expect(result).toBe(true)
    })

    it('should allow any query when user has admin role', async () => {
        const adminConfig: StarbaseDBConfiguration = {
            role: 'admin',
        } as any
        const result = await isQueryAllowed({
            sql: 'DROP TABLE users',
            isEnabled: true,
            dataSource: mockDataSource,
            config: adminConfig,
        })
        expect(result).toBe(true)
    })

    it('should throw error when sql is empty', async () => {
        await expect(
            isQueryAllowed({
                sql: '',
                isEnabled: true,
                dataSource: mockDataSource,
                config: mockConfig,
            })
        ).rejects.toThrow('No SQL provided for allowlist check')
    })

    it('should allow matching query in allowlist', async () => {
        const ds: DataSource = {
            name: 'test-db',
            source: 'internal',
            type: 'sqlite',
            rpc: {
                executeQuery: vi.fn().mockResolvedValue([
                    {
                        sql_statement: 'SELECT id, name FROM users WHERE id = 1',
                        source: 'internal',
                    },
                ]),
            } as any,
        }

        const result = await isQueryAllowed({
            sql: 'SELECT id, name FROM users WHERE id = 1;',
            isEnabled: true,
            dataSource: ds,
            config: mockConfig,
        })
        expect(result).toBe(true)
    })

    it('should handle whitespace and semicolon normalization', async () => {
        const ds: DataSource = {
            name: 'test-db',
            source: 'internal',
            type: 'sqlite',
            rpc: {
                executeQuery: vi.fn().mockResolvedValue([
                    {
                        sql_statement: 'SELECT id FROM users;',
                        source: 'internal',
                    },
                ]),
            } as any,
        }

        const result = await isQueryAllowed({
            sql: '  SELECT id FROM users  ',
            isEnabled: true,
            dataSource: ds,
            config: mockConfig,
        })
        expect(result).toBe(true)
    })

    it('should reject unlisted query and record rejection', async () => {
        const executeQueryMock = vi.fn().mockImplementation(async ({ sql }) => {
            if (sql.includes('SELECT sql_statement')) {
                return [
                    {
                        sql_statement: 'SELECT id FROM allowed_table',
                        source: 'internal',
                    },
                ]
            }
            if (sql.includes('INSERT INTO tmp_allowlist_rejections')) {
                return [{ sql_statement: 'SELECT * FROM forbidden' }]
            }
            return []
        })

        const ds: DataSource = {
            name: 'test-db',
            source: 'internal',
            type: 'sqlite',
            rpc: { executeQuery: executeQueryMock } as any,
        }

        await expect(
            isQueryAllowed({
                sql: 'SELECT * FROM forbidden',
                isEnabled: true,
                dataSource: ds,
                config: mockConfig,
            })
        ).rejects.toThrow('Query not allowed')

        expect(executeQueryMock).toHaveBeenCalledWith(
            expect.objectContaining({
                sql: expect.stringContaining('INSERT INTO tmp_allowlist_rejections'),
                params: ['SELECT * FROM forbidden', 'internal'],
            })
        )
    })

    it('should isolate queries by dataSource source', async () => {
        const ds: DataSource = {
            name: 'external-db',
            source: 'external-1',
            type: 'postgres',
            rpc: {
                executeQuery: vi.fn().mockResolvedValue([
                    {
                        sql_statement: 'SELECT count(*) FROM items',
                        source: 'internal', // Different source
                    },
                ]),
            } as any,
        }

        await expect(
            isQueryAllowed({
                sql: 'SELECT count(*) FROM items',
                isEnabled: true,
                dataSource: ds,
                config: mockConfig,
            })
        ).rejects.toThrow('Query not allowed')
    })
})
