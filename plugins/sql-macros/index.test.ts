import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SqlMacrosPlugin } from './index'
import type { StarbaseApp } from '../../src/handler'
import type { DataSource } from '../../src/types'

type Middleware = (context: any, next: () => Promise<void>) => Promise<void>

let plugin: SqlMacrosPlugin
let middleware: Middleware
let dataSource: DataSource

const createApp = () =>
    ({
        use: vi.fn((registeredMiddleware: Middleware) => {
            middleware = registeredMiddleware
        }),
    }) as unknown as StarbaseApp

const createContext = (role: string) => ({
    get: vi.fn((key: string) => {
        if (key === 'config') return { role }
        return undefined
    }),
})

describe('SqlMacrosPlugin', () => {
    beforeEach(() => {
        vi.clearAllMocks()

        plugin = new SqlMacrosPlugin({ preventSelectStar: true })
        dataSource = {
            source: 'internal',
            rpc: {
                executeQuery: vi
                    .fn()
                    .mockResolvedValue([
                        { column_name: 'id' },
                        { column_name: 'email' },
                        { column_name: 'password' },
                        { column_name: 'created_at' },
                    ]),
            },
        } as unknown as DataSource
    })

    it('initializes with select-star prevention enabled', () => {
        expect(plugin.name).toBe('starbasedb:sql-macros')
        expect(plugin.opts.requiresAuth).toBe(true)
        expect(plugin.preventSelectStar).toBe(true)
    })

    it('registers middleware that captures the request config', async () => {
        const app = createApp()
        const next = vi.fn().mockResolvedValue(undefined)

        await plugin.register(app)
        await middleware(createContext('user'), next)

        expect(app.use).toHaveBeenCalledTimes(1)
        expect(plugin.config).toEqual({ role: 'user' })
        expect(next).toHaveBeenCalledTimes(1)
    })

    it('returns SQL unchanged when no data source is provided', async () => {
        const result = await plugin.beforeQuery({
            sql: 'SELECT * FROM users',
            params: [1],
        })

        expect(result).toEqual({
            sql: 'SELECT * FROM users',
            params: [1],
        })
    })

    it('preserves SELECT * when the parser cannot inspect it', async () => {
        plugin.config = { role: 'user' } as any

        const result = await plugin.beforeQuery({
            sql: 'SELECT * FROM users',
            dataSource,
        })

        expect(result.sql).toBe('SELECT * FROM users')
    })

    it('allows SELECT * for admin users', async () => {
        plugin.config = { role: 'admin' } as any

        const result = await plugin.beforeQuery({
            sql: 'SELECT * FROM users',
            dataSource,
        })

        expect(result.sql).toBe('SELECT * FROM users')
    })

    it('expands $_exclude columns for internal data sources', async () => {
        plugin.config = { role: 'admin' } as any

        const result = await plugin.beforeQuery({
            sql: 'SELECT $_exclude(password) FROM users',
            dataSource,
        })

        expect(dataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: expect.stringContaining("FROM pragma_table_info('users')"),
        })
        expect(result.sql).toBe(
            'SELECT `id`, `email`, `created_at` FROM `users`'
        )
    })

    it('leaves $_exclude SQL unchanged for external data sources', async () => {
        const externalDataSource = {
            ...dataSource,
            source: 'postgres',
        } as unknown as DataSource

        const result = await plugin.beforeQuery({
            sql: 'SELECT $_exclude(password) FROM users',
            dataSource: externalDataSource,
        })

        expect(result.sql).toBe('SELECT $_exclude(password) FROM users')
        expect(externalDataSource.rpc.executeQuery).not.toHaveBeenCalled()
    })

    it('does not rewrite pragma_table_info queries', async () => {
        const sql = "SELECT name FROM pragma_table_info('users')"

        const result = await plugin.beforeQuery({
            sql,
            dataSource,
        })

        expect(result.sql).toBe(sql)
        expect(dataSource.rpc.executeQuery).not.toHaveBeenCalled()
    })
})
