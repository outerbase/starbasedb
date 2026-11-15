import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SqlMacrosPlugin } from './index'
import { DataSource } from '../../src/types'
import { StarbaseDBConfiguration } from '../../src/handler'

describe('SqlMacrosPlugin (plugins/sql-macros/index.ts)', () => {
    let plugin: SqlMacrosPlugin
    let mockExecuteQuery: ReturnType<typeof vi.fn>
    let mockDataSource: DataSource

    beforeEach(() => {
        plugin = new SqlMacrosPlugin({ preventSelectStar: false })
        mockExecuteQuery = vi.fn()
        mockDataSource = {
            source: 'internal',
            rpc: {
                executeQuery: mockExecuteQuery,
            },
        } as unknown as DataSource
    })

    describe('Initialization & Registration', () => {
        it('should initialize with correct plugin name and options', () => {
            const p = new SqlMacrosPlugin({ preventSelectStar: true })
            expect(p.name).toBe('starbasedb:sql-macros')
            expect(p.preventSelectStar).toBe(true)
        })

        it('should register middleware and capture config from context', async () => {
            const mockApp = {
                use: vi.fn(),
            }
            await plugin.register(mockApp as any)
            expect(mockApp.use).toHaveBeenCalledTimes(1)

            // Test captured middleware function
            const middleware = mockApp.use.mock.calls[0][0]
            const mockContext = {
                get: vi.fn().mockReturnValue({ role: 'admin' }),
            }
            const next = vi.fn()

            await middleware(mockContext, next)
            expect(plugin.config).toEqual({ role: 'admin' })
            expect(next).toHaveBeenCalledTimes(1)
        })
    })

    describe('Select Star Prevention (checkSelectStar)', () => {
        beforeEach(() => {
            plugin = new SqlMacrosPlugin({ preventSelectStar: true })
            plugin.config = { role: 'user' } as StarbaseDBConfiguration
        })

        it('should throw an error on SELECT * for non-admin users', async () => {
            await expect(
                plugin.beforeQuery({
                    sql: 'SELECT * FROM customers;',
                    dataSource: mockDataSource,
                })
            ).rejects.toThrow(
                'SELECT * is not allowed. Please specify explicit columns.'
            )
        })

        it('should allow explicit column selection on SELECT queries', async () => {
            const result = await plugin.beforeQuery({
                sql: 'SELECT id, email, created_at FROM customers;',
                dataSource: mockDataSource,
            })

            expect(result.sql).toContain(
                'SELECT id, email, created_at FROM customers'
            )
        })

        it('should allow SELECT * when user role is admin', async () => {
            plugin.config = { role: 'admin' } as StarbaseDBConfiguration

            const result = await plugin.beforeQuery({
                sql: 'SELECT * FROM customers;',
                dataSource: mockDataSource,
            })

            expect(result.sql).toBe('SELECT * FROM customers;')
        })

        it('should not throw error on non-SELECT statements (INSERT/UPDATE/DELETE)', async () => {
            const result = await plugin.beforeQuery({
                sql: 'UPDATE customers SET active = 1 WHERE id = 5;',
                dataSource: mockDataSource,
            })

            expect(result.sql).toContain('UPDATE customers SET active = 1')
        })

        it('should gracefully return original SQL if SQL syntax is invalid in checkSelectStar', async () => {
            const malformedSql = 'SELECT FROM WHERE INVALID;'
            const result = await plugin.beforeQuery({
                sql: malformedSql,
                dataSource: mockDataSource,
            })

            expect(result.sql).toBe(malformedSql)
        })
    })

    describe('Exclude Columns Macro ($exclude / replaceExcludeColumns)', () => {
        beforeEach(() => {
            plugin = new SqlMacrosPlugin({ preventSelectStar: false })
        })

        it('should return original SQL if dataSource is missing', async () => {
            const sql = 'SELECT id FROM users;'
            const result = await plugin.beforeQuery({ sql })
            expect(result.sql).toBe(sql)
        })

        it('should return original SQL if dataSource.source is not internal', async () => {
            const externalDataSource = {
                source: 'postgres',
                rpc: { executeQuery: mockExecuteQuery },
            } as unknown as DataSource

            const sql = 'SELECT $_exclude(password) FROM users;'
            const result = await plugin.beforeQuery({
                sql,
                dataSource: externalDataSource,
            })

            expect(result.sql).toBe(sql)
            expect(mockExecuteQuery).not.toHaveBeenCalled()
        })

        it('should return original SQL for pragma_table_info queries', async () => {
            const pragmaSql = 'SELECT * FROM pragma_table_info("users");'
            const result = await plugin.beforeQuery({
                sql: pragmaSql,
                dataSource: mockDataSource,
            })

            expect(result.sql).toBe(pragmaSql)
            expect(mockExecuteQuery).not.toHaveBeenCalled()
        })

        it('should replace $_exclude with remaining columns for a single excluded column', async () => {
            mockExecuteQuery.mockResolvedValueOnce([
                { column_name: 'id' },
                { column_name: 'username' },
                { column_name: 'password_hash' },
                { column_name: 'email' },
            ])

            const sql = 'SELECT $_exclude(password_hash) FROM users;'
            const result = await plugin.beforeQuery({
                sql,
                dataSource: mockDataSource,
            })

            expect(mockExecuteQuery).toHaveBeenCalledTimes(1)
            expect(result.sql).toContain('`id`')
            expect(result.sql).toContain('`username`')
            expect(result.sql).toContain('`email`')
            expect(result.sql).not.toContain('password_hash')
        })

        it('should replace $_exclude with multiple excluded columns', async () => {
            mockExecuteQuery.mockResolvedValueOnce([
                { column_name: 'id' },
                { column_name: 'secret_key' },
                { column_name: 'token' },
                { column_name: 'public_name' },
            ])

            const sql = 'SELECT $_exclude(secret_key, token) FROM accounts;'
            const result = await plugin.beforeQuery({
                sql,
                dataSource: mockDataSource,
            })

            expect(result.sql).toContain('`id`')
            expect(result.sql).toContain('`public_name`')
            expect(result.sql).not.toContain('secret_key')
            expect(result.sql).not.toContain('token')
        })

        it('should handle queries without any $_exclude function normally', async () => {
            const sql = 'SELECT id, title FROM posts;'
            const result = await plugin.beforeQuery({
                sql,
                dataSource: mockDataSource,
            })

            expect(result.sql).toBe(sql)
            expect(mockExecuteQuery).not.toHaveBeenCalled()
        })
    })
})
