import { describe, expect, it, vi } from 'vitest'
import { SqlMacrosPlugin } from './index'
import { DataSource } from '../../src/types'

function createInternalDataSource(columns: string[] = []): DataSource {
    return {
        source: 'internal',
        rpc: {
            executeQuery: vi.fn().mockResolvedValue(
                columns.map((column_name) => ({
                    column_name,
                }))
            ),
        },
    } as unknown as DataSource
}

describe('SqlMacrosPlugin', () => {
    it('leaves SQL unchanged when no data source is provided', async () => {
        const plugin = new SqlMacrosPlugin({ preventSelectStar: true })
        const sql = 'SELECT * FROM users'

        const result = await plugin.beforeQuery({ sql, params: [1] })

        expect(result).toEqual({ sql, params: [1] })
    })

    it('expands $_exclude into explicit internal table columns', async () => {
        const plugin = new SqlMacrosPlugin()
        const dataSource = createInternalDataSource(['id', 'email', 'password'])

        const result = await plugin.beforeQuery({
            sql: 'SELECT $_exclude(password) FROM users',
            dataSource,
        })

        expect(result.params).toBeUndefined()
        expect(result.sql).toContain('SELECT')
        expect(result.sql).toContain('id')
        expect(result.sql).toContain('email')
        expect(result.sql).not.toContain('password')
        expect(dataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: expect.stringContaining("FROM pragma_table_info('users')"),
        })
    })

    it('does not expand $_exclude for external data sources', async () => {
        const plugin = new SqlMacrosPlugin()
        const dataSource = {
            source: 'external',
            external: { dialect: 'postgresql' },
            rpc: {
                executeQuery: vi.fn(),
            },
        } as unknown as DataSource
        const sql = 'SELECT $_exclude(password) FROM users'

        const result = await plugin.beforeQuery({ sql, dataSource })

        expect(result.sql).toBe(sql)
        expect(dataSource.rpc.executeQuery).not.toHaveBeenCalled()
    })

    it('rejects SELECT * for non-admin users when enabled', async () => {
        const plugin = new SqlMacrosPlugin({ preventSelectStar: true })
        plugin['config'] = { role: 'user' } as any

        await expect(
            plugin.beforeQuery({
                sql: 'SELECT * FROM users',
                dataSource: createInternalDataSource(),
            })
        ).rejects.toThrow(
            'SELECT * is not allowed. Please specify explicit columns.'
        )
    })

    it('allows SELECT * for admin users when prevention is enabled', async () => {
        const plugin = new SqlMacrosPlugin({ preventSelectStar: true })
        plugin['config'] = { role: 'admin' } as any
        const sql = 'SELECT * FROM users'

        const result = await plugin.beforeQuery({
            sql,
            dataSource: createInternalDataSource(),
        })

        expect(result.sql).toBe(sql)
    })
})
