import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SqlMacrosPlugin } from './index'

describe('SqlMacrosPlugin - Initialization', () => {
    it('should initialize with correct plugin name and default options', () => {
        const plugin = new SqlMacrosPlugin()
        expect(plugin).toBeInstanceOf(SqlMacrosPlugin)
        expect(plugin.name).toBe('starbasedb:sql-macros')
        expect(plugin.preventSelectStar).toBeUndefined()
    })

    it('should configure preventSelectStar option correctly', () => {
        const plugin = new SqlMacrosPlugin({ preventSelectStar: true })
        expect(plugin.preventSelectStar).toBe(true)
    })
})

describe('SqlMacrosPlugin - beforeQuery()', () => {
    it('should return unchanged query when dataSource is not provided', async () => {
        const plugin = new SqlMacrosPlugin({ preventSelectStar: true })
        const sql = 'SELECT * FROM users'
        const params = [1, 2]

        const result = await plugin.beforeQuery({
            sql,
            params,
            dataSource: undefined,
        })

        expect(result.sql).toBe(sql)
        expect(result.params).toEqual(params)
    })

    it('should allow SELECT queries without wildcard', async () => {
        const plugin = new SqlMacrosPlugin({ preventSelectStar: true })
        plugin.config = { role: 'user' } as any

        const mockDataSource: any = {}
        const sql = 'SELECT id, name FROM users'

        const result = await plugin.beforeQuery({
            sql,
            params: [],
            dataSource: mockDataSource,
        })

        expect(result.sql).toBe(sql)
    })

    it('should permit SELECT * queries when executed by admin role', async () => {
        const plugin = new SqlMacrosPlugin({ preventSelectStar: true })
        plugin.config = { role: 'admin' } as any

        const mockDataSource: any = {}
        const sql = 'SELECT * FROM accounts'

        const result = await plugin.beforeQuery({
            sql,
            params: [],
            dataSource: mockDataSource,
        })

        expect(result.sql).toBe(sql)
    })
})
