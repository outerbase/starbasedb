import { describe, expect, it, vi } from 'vitest'
import { SqlMacrosPlugin } from './index'
import { DataSource } from '../../src/types'
import { StarbaseDBConfiguration } from '../../src/handler'

describe('SqlMacrosPlugin', () => {
    const mockInternalDataSource: DataSource = {
        name: 'test-db',
        source: 'internal',
        type: 'sqlite',
        rpc: {
            executeQuery: vi.fn(),
        } as any,
    }

    const mockExternalDataSource: DataSource = {
        name: 'pg-db',
        source: 'external',
        type: 'postgres',
        rpc: { executeQuery: vi.fn() } as any,
    }

    const userConfig: StarbaseDBConfiguration = {
        role: 'user',
    } as any

    const adminConfig: StarbaseDBConfiguration = {
        role: 'admin',
    } as any

    it('should initialize with correct plugin name and options', () => {
        const plugin = new SqlMacrosPlugin({ preventSelectStar: true })
        expect(plugin.name).toBe('starbasedb:sql-macros')
        expect(plugin.preventSelectStar).toBe(true)
    })

    it('should return original sql when no dataSource is provided', async () => {
        const plugin = new SqlMacrosPlugin({ preventSelectStar: true })
        const res = await plugin.beforeQuery({
            sql: 'SELECT * FROM users',
            params: [],
        })
        expect(res.sql).toBe('SELECT * FROM users')
    })

    describe('preventSelectStar enforcement', () => {
        it('should throw error when non-admin executes SELECT *', async () => {
            const plugin = new SqlMacrosPlugin({ preventSelectStar: true })
            plugin.config = userConfig

            await expect(
                plugin.beforeQuery({
                    sql: 'SELECT * FROM users',
                    dataSource: mockInternalDataSource,
                    config: userConfig,
                })
            ).rejects.toThrow('SELECT * is not allowed. Please specify explicit columns.')
        })

        it('should allow SELECT * when user has admin role', async () => {
            const plugin = new SqlMacrosPlugin({ preventSelectStar: true })
            plugin.config = adminConfig

            const res = await plugin.beforeQuery({
                sql: 'SELECT * FROM users',
                dataSource: mockInternalDataSource,
                config: adminConfig,
            })
            expect(res.sql).toBe('SELECT * FROM users')
        })

        it('should allow explicit column selection for non-admin', async () => {
            const plugin = new SqlMacrosPlugin({ preventSelectStar: true })
            plugin.config = userConfig

            const res = await plugin.beforeQuery({
                sql: 'SELECT id, email FROM users',
                dataSource: mockInternalDataSource,
                config: userConfig,
            })
            expect(res.sql).toBe('SELECT id, email FROM users')
        })
    })

    describe('$_exclude column macro replacement', () => {
        it('should bypass non-internal data sources', async () => {
            const plugin = new SqlMacrosPlugin({ preventSelectStar: false })
            const sql = 'SELECT id, $_exclude(password) FROM users'
            const res = await plugin.beforeQuery({
                sql,
                dataSource: mockExternalDataSource,
                config: userConfig,
            })
            expect(res.sql).toBe(sql)
        })

        it('should replace $_exclude with remaining table columns on internal SQLite data source', async () => {
            const executeQueryMock = vi.fn().mockResolvedValue([
                { column_name: 'id' },
                { column_name: 'username' },
                { column_name: 'email' },
                { column_name: 'password' },
            ])

            const ds: DataSource = {
                name: 'test-db',
                source: 'internal',
                type: 'sqlite',
                rpc: { executeQuery: executeQueryMock } as any,
            }

            const plugin = new SqlMacrosPlugin({ preventSelectStar: false })
            const res = await plugin.beforeQuery({
                sql: 'SELECT $_exclude(password) FROM users;',
                dataSource: ds,
                config: userConfig,
            })

            expect(executeQueryMock).toHaveBeenCalledWith(
                expect.objectContaining({
                    sql: expect.stringContaining("pragma_table_info('users')"),
                })
            )
            expect(res.sql.toLowerCase()).toContain('id')
            expect(res.sql.toLowerCase()).toContain('username')
            expect(res.sql.toLowerCase()).toContain('email')
            expect(res.sql.toLowerCase()).not.toContain('password')
        })

        it('should ignore pragma_table_info queries', async () => {
            const plugin = new SqlMacrosPlugin({ preventSelectStar: false })
            const pragmaSql = "SELECT name FROM pragma_table_info('users')"
            const res = await plugin.beforeQuery({
                sql: pragmaSql,
                dataSource: mockInternalDataSource,
                config: userConfig,
            })
            expect(res.sql).toBe(pragmaSql)
        })
    })
})
