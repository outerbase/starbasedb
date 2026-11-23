import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SqlMacrosPlugin } from './index'
import { StarbaseApp, StarbaseDBConfiguration } from '../../src/handler'
import { DataSource } from '../../src/types'

describe('SqlMacrosPlugin', () => {
    let plugin: SqlMacrosPlugin
    let mockDataSource: DataSource
    let mockApp: StarbaseApp

    beforeEach(() => {
        vi.clearAllMocks()
        mockDataSource = {
            source: 'internal',
            rpc: {
                executeQuery: vi.fn().mockResolvedValue([
                    { column_name: 'id' },
                    { column_name: 'name' },
                    { column_name: 'email' },
                    { column_name: 'password' },
                ]),
            },
        } as unknown as DataSource

        plugin = new SqlMacrosPlugin({ preventSelectStar: true })
    })

    describe('Initialization', () => {
        it('should initialize with provided preventSelectStar option', () => {
            expect(plugin.name).toBe('starbasedb:sql-macros')
            expect(plugin.preventSelectStar).toBe(true)
        })

        it('should initialize with undefined option when not provided', () => {
            const defaultPlugin = new SqlMacrosPlugin()
            expect(defaultPlugin.preventSelectStar).toBeUndefined()
        })
    })

    describe('register()', () => {
        it('should register middleware and capture config', async () => {
            const mockConfig: StarbaseDBConfiguration = { role: 'admin' } as any
            const mockContext = {
                get: vi.fn().mockReturnValue(mockConfig),
            }
            const next = vi.fn()

            mockApp = {
                use: vi.fn((middleware) => middleware(mockContext, next)),
            } as unknown as StarbaseApp

            await plugin.register(mockApp)

            expect(mockApp.use).toHaveBeenCalledTimes(1)
            expect(mockContext.get).toHaveBeenCalledWith('config')
            expect(next).toHaveBeenCalledTimes(1)
            expect(plugin.config).toEqual(mockConfig)
        })
    })

    describe('beforeQuery()', () => {
        it('should return original sql and params if dataSource is missing', async () => {
            const sql = 'SELECT * FROM users'
            const params = [1]
            const result = await plugin.beforeQuery({ sql, params })

            expect(result).toEqual({ sql, params })
        })

        it('should throw error when preventSelectStar is true and user is non-admin', async () => {
            plugin.config = { role: 'user' } as any
            const sql = 'SELECT * FROM users'

            await expect(
                plugin.beforeQuery({
                    sql,
                    dataSource: mockDataSource,
                })
            ).rejects.toThrow('SELECT * is not allowed. Please specify explicit columns.')
        })

        it('should allow SELECT * when role is admin', async () => {
            plugin.config = { role: 'admin' } as any
            const sql = 'SELECT * FROM users'

            const result = await plugin.beforeQuery({
                sql,
                dataSource: mockDataSource,
            })

            expect(result.sql).toBe(sql)
        })

        it('should allow non-select statements even if preventSelectStar is enabled', async () => {
            plugin.config = { role: 'user' } as any
            const sql = 'INSERT INTO users (id, name) VALUES (1, "Alice")'

            const result = await plugin.beforeQuery({
                sql,
                dataSource: mockDataSource,
            })

            expect(result.sql).toBe(sql)
        })

        it('should bypass column exclusion for non-internal data sources', async () => {
            const externalDataSource = {
                source: 'external',
                rpc: { executeQuery: vi.fn() },
            } as unknown as DataSource

            const sql = 'SELECT (password) FROM users'
            const result = await plugin.beforeQuery({
                sql,
                dataSource: externalDataSource,
            })

            expect(result.sql).toBe(sql)
            expect(externalDataSource.rpc.executeQuery).not.toHaveBeenCalled()
        })

        it('should bypass pragma_table_info queries', async () => {
            const sql = 'SELECT * FROM pragma_table_info("users")'
            const result = await plugin.beforeQuery({
                sql,
                dataSource: mockDataSource,
            })

            expect(result.sql).toBe(sql)
            expect(mockDataSource.rpc.executeQuery).not.toHaveBeenCalled()
        })

        it('should replace  with explicit columns from internal SQLite schema', async () => {
            plugin.config = { role: 'admin' } as any
            const sql = 'SELECT (password) FROM users'

            const result = await plugin.beforeQuery({
                sql,
                dataSource: mockDataSource,
            })

            expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledWith({
                sql: expect.stringContaining("pragma_table_info('users')"),
            })
            expect(result.sql).toContain('id')
            expect(result.sql).toContain('name')
            expect(result.sql).toContain('email')
            expect(result.sql).not.toContain('password')
        })
    })
})
