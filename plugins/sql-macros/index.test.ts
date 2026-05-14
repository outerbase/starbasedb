import { describe, expect, it, vi } from 'vitest'
import { SqlMacrosPlugin } from './index'
import type { DataSource } from '../../src/types'

const makeInternalDataSource = (columns: string[] = []): DataSource =>
    ({
        source: 'internal',
        rpc: {
            executeQuery: vi
                .fn()
                .mockResolvedValue(
                    columns.map((column_name) => ({ column_name }))
                ),
        },
    }) as unknown as DataSource

const makeExternalDataSource = (): DataSource =>
    ({
        source: 'external',
        rpc: {
            executeQuery: vi.fn(),
        },
    }) as unknown as DataSource

describe('SqlMacrosPlugin', () => {
    it('returns the original query when no data source is available', async () => {
        const plugin = new SqlMacrosPlugin({ preventSelectStar: true })

        const result = await plugin.beforeQuery({
            sql: 'SELECT * FROM users WHERE id = ?',
            params: [1],
        })

        expect(result).toEqual({
            sql: 'SELECT * FROM users WHERE id = ?',
            params: [1],
        })
    })

    it('does not rewrite queries for external data sources', async () => {
        const dataSource = makeExternalDataSource()
        const plugin = new SqlMacrosPlugin({ preventSelectStar: false })

        const result = await plugin.beforeQuery({
            sql: 'SELECT $_exclude(email) FROM users',
            dataSource,
        })

        expect(result.sql).toBe('SELECT $_exclude(email) FROM users')
        expect(dataSource.rpc.executeQuery).not.toHaveBeenCalled()
    })

    it('rejects SELECT star for non-admin users when the guard is enabled', async () => {
        const plugin = new SqlMacrosPlugin({ preventSelectStar: true })
        plugin.config = { role: 'user' } as any

        await expect(
            plugin.beforeQuery({
                sql: 'SELECT * FROM users',
                dataSource: makeInternalDataSource(),
            })
        ).rejects.toThrow(
            'SELECT * is not allowed. Please specify explicit columns.'
        )
    })

    it('allows SELECT star for admins', async () => {
        const plugin = new SqlMacrosPlugin({ preventSelectStar: true })
        plugin.config = { role: 'admin' } as any

        const result = await plugin.beforeQuery({
            sql: 'SELECT * FROM users',
            dataSource: makeInternalDataSource(),
        })

        expect(result.sql).toBe('SELECT * FROM users')
    })

    it('expands $_exclude into explicit included columns for internal SQLite sources', async () => {
        const dataSource = makeInternalDataSource(['id', 'name', 'email'])
        const plugin = new SqlMacrosPlugin({ preventSelectStar: false })

        const result = await plugin.beforeQuery({
            sql: 'SELECT $_exclude(email) FROM users',
            params: ['active'],
            dataSource,
        })

        expect(dataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: expect.stringContaining("pragma_table_info('users')"),
        })
        expect(result.params).toEqual(['active'])
        expect(result.sql).toContain('id')
        expect(result.sql).toContain('name')
        expect(result.sql).not.toContain('email')
        expect(result.sql).not.toContain('$_exclude')
    })
})
