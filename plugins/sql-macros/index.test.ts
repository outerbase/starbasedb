import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SqlMacrosPlugin } from './index'
import { Hono } from 'hono'
import type { DataSource } from '../../src/types'
import type { StarbaseDBConfiguration } from '../../src/handler'

describe('SqlMacrosPlugin', () => {
    let plugin: SqlMacrosPlugin
    let mockDataSource: DataSource
    let mockConfig: StarbaseDBConfiguration

    beforeEach(() => {
        vi.clearAllMocks()

        mockConfig = {
            role: 'client',
            outerbaseApiKey: 'mock-key',
        }

        mockDataSource = {
            source: 'internal',
            rpc: {
                executeQuery: vi
                    .fn()
                    .mockResolvedValue([
                        { column_name: 'id' },
                        { column_name: 'name' },
                        { column_name: 'email' },
                        { column_name: 'password' },
                    ]),
            } as any,
        }

        plugin = new SqlMacrosPlugin({ preventSelectStar: true })
    })

    describe('Initialization & Registration', () => {
        it('should initialize with correct plugin name and options', () => {
            expect(plugin.name).toBe('starbasedb:sql-macros')
            expect(plugin.preventSelectStar).toBe(true)
        })

        it('should capture config from middleware', async () => {
            const app = new Hono<any>()
            app.use('*', async (c, next) => {
                c.set('config', mockConfig)
                await next()
            })
            await plugin.register(app as any)

            app.get('/test', (c) => c.text('ok'))
            await app.request('http://localhost/test')

            expect(plugin.config).toEqual(mockConfig)
        })
    })

    describe('preventSelectStar enforcement', () => {
        it('should throw error when non-admin executes SELECT *', async () => {
            plugin.config = { role: 'client' }

            await expect(
                plugin.beforeQuery({
                    sql: 'SELECT * FROM users;',
                    dataSource: mockDataSource,
                    config: plugin.config,
                })
            ).rejects.toThrow(
                'SELECT * is not allowed. Please specify explicit columns.'
            )
        })

        it('should allow SELECT * when role is admin', async () => {
            plugin.config = { role: 'admin' }

            const res = await plugin.beforeQuery({
                sql: 'SELECT * FROM users',
                dataSource: mockDataSource,
                config: plugin.config,
            })

            expect(res.sql).toBe('SELECT * FROM users')
        })

        it('should allow SELECT with explicit columns for non-admin', async () => {
            plugin.config = { role: 'client' }

            const res = await plugin.beforeQuery({
                sql: 'SELECT id, name FROM users',
                dataSource: mockDataSource,
                config: plugin.config,
            })

            expect(res.sql).toBe('SELECT id, name FROM users')
        })

        it('should not throw for non-SELECT statements like INSERT or UPDATE', async () => {
            plugin.config = { role: 'client' }

            const res = await plugin.beforeQuery({
                sql: "INSERT INTO users (id, name) VALUES (1, 'Alice')",
                dataSource: mockDataSource,
                config: plugin.config,
            })

            expect(res.sql).toContain('INSERT INTO users')
        })

        it('should return original SQL if preventSelectStar is disabled', async () => {
            const lenientPlugin = new SqlMacrosPlugin({
                preventSelectStar: false,
            })
            lenientPlugin.config = { role: 'client' }

            const res = await lenientPlugin.beforeQuery({
                sql: 'SELECT * FROM users',
                dataSource: mockDataSource,
                config: lenientPlugin.config,
            })

            expect(res.sql).toBe('SELECT * FROM users')
        })
    })

    describe('$_exclude / __exclude macro processing', () => {
        it('should expand $_exclude to all columns except the excluded one', async () => {
            plugin.config = { role: 'admin' }

            const res = await plugin.beforeQuery({
                sql: 'SELECT $_exclude(password) FROM users',
                dataSource: mockDataSource,
                config: plugin.config,
            })

            expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledWith({
                sql: expect.stringContaining("pragma_table_info('users')"),
            })
            expect(res.sql).toContain('`id`')
            expect(res.sql).toContain('`name`')
            expect(res.sql).toContain('`email`')
            expect(res.sql).not.toContain('`password`')
        })

        it('should return original SQL if data source is external', async () => {
            plugin.config = { role: 'admin' }
            const externalDs: DataSource = {
                source: 'external',
                external: { provider: 'postgres' } as any,
                rpc: { executeQuery: vi.fn() } as any,
            }

            const res = await plugin.beforeQuery({
                sql: 'SELECT $_exclude(password) FROM users',
                dataSource: externalDs,
                config: plugin.config,
            })

            expect(res.sql).toBe('SELECT $_exclude(password) FROM users')
            expect(externalDs.rpc.executeQuery).not.toHaveBeenCalled()
        })

        it('should return original SQL if query is a pragma_table_info query', async () => {
            plugin.config = { role: 'admin' }

            const res = await plugin.beforeQuery({
                sql: "SELECT * FROM pragma_table_info('users')",
                dataSource: mockDataSource,
                config: plugin.config,
            })

            expect(res.sql).toContain('pragma_table_info')
        })

        it('should return untouched sql and params if dataSource is undefined', async () => {
            const res = await plugin.beforeQuery({
                sql: 'SELECT id FROM users',
                params: [1],
                dataSource: undefined,
            })

            expect(res.sql).toBe('SELECT id FROM users')
            expect(res.params).toEqual([1])
        })
    })
})
