import { describe, expect, it, vi } from 'vitest'
import { SqlMacrosPlugin } from './index'
import { DataSource } from '../../src/types'

function createSchemaMockDataSource(columns: string[], source = 'internal'): DataSource {
    return {
        source,
        rpc: {
            executeQuery: vi.fn(async () =>
                columns.map((col) => ({ column_name: col }))
            ),
        } as any,
    }
}

describe('SqlMacrosPlugin (plugins/sql-macros)', () => {
    it('blocks SELECT * for non-admin users when preventSelectStar is enabled', async () => {
        const plugin = new SqlMacrosPlugin({ preventSelectStar: true })
        plugin.config = { role: 'user' } as any
        const ds = createSchemaMockDataSource(['id', 'email'])

        await expect(
            plugin.beforeQuery({
                sql: 'SELECT * FROM users',
                dataSource: ds,
            })
        ).rejects.toThrow('SELECT * is not allowed. Please specify explicit columns.')

        await expect(
            plugin.beforeQuery({
                sql: 'SELECT users.* FROM users',
                dataSource: ds,
            })
        ).rejects.toThrow('SELECT * is not allowed. Please specify explicit columns.')
    })

    it('allows SELECT * for admin users even when preventSelectStar is enabled', async () => {
        const plugin = new SqlMacrosPlugin({ preventSelectStar: true })
        plugin.config = { role: 'admin' } as any
        const ds = createSchemaMockDataSource(['id', 'email'])

        const res = await plugin.beforeQuery({
            sql: 'SELECT * FROM users',
            dataSource: ds,
        })
        expect(res.sql).toBe('SELECT * FROM users')
    })

    it('expands $_exclude macro into explicit table columns excluding specified columns', async () => {
        const plugin = new SqlMacrosPlugin({ preventSelectStar: false })
        const ds = createSchemaMockDataSource(['id', 'name', 'password_hash'])

        const res = await plugin.beforeQuery({
            sql: 'SELECT $_exclude(password_hash) FROM users',
            dataSource: ds,
        })

        expect(res.sql).toContain('id')
        expect(res.sql).toContain('name')
        expect(res.sql).not.toContain('password_hash')
    })

    it('returns original SQL when dataSource is missing or non-internal', async () => {
        const plugin = new SqlMacrosPlugin()
        const externalDs = createSchemaMockDataSource(['id'], 'external')

        const noDsResult = await plugin.beforeQuery({
            sql: 'SELECT $_exclude(secret) FROM accounts',
        })
        expect(noDsResult.sql).toBe('SELECT $_exclude(secret) FROM accounts')

        const extResult = await plugin.beforeQuery({
            sql: 'SELECT $_exclude(secret) FROM accounts',
            dataSource: externalDs,
        })
        expect(extResult.sql).toBe('SELECT $_exclude(secret) FROM accounts')
    })
})
