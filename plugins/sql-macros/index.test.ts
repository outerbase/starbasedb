import { describe, expect, it, vi } from 'vitest'
import { SqlMacrosPlugin } from './index'
import type { DataSource } from '../../src/types'

const createMockDataSource = (
    opts: {
        source?: string
        columns?: string[]
    } = {}
) => {
    const columns = opts.columns ?? ['id', 'name', 'email', 'password']
    const executeQuery = vi.fn().mockResolvedValue(
        columns.map((column_name) => ({
            column_name,
        }))
    )

    return {
        source: opts.source ?? 'internal',
        rpc: {
            executeQuery,
        },
    } as unknown as DataSource
}

describe('SqlMacrosPlugin', () => {
    it('returns the original SQL and params when no data source is provided', async () => {
        const plugin = new SqlMacrosPlugin({ preventSelectStar: true })
        const params = [1]

        await expect(
            plugin.beforeQuery({
                sql: 'SELECT * FROM users WHERE id = ?',
                params,
            })
        ).resolves.toEqual({
            sql: 'SELECT * FROM users WHERE id = ?',
            params,
        })
    })

    it('blocks SELECT * for non-admin users when prevention is enabled', async () => {
        const plugin = new SqlMacrosPlugin({ preventSelectStar: true })
        plugin.config = { role: 'user' } as any

        await expect(
            plugin.beforeQuery({
                sql: 'SELECT * FROM users',
                dataSource: createMockDataSource(),
            })
        ).rejects.toThrow(
            'SELECT * is not allowed. Please specify explicit columns.'
        )
    })

    it('allows SELECT * for admin users', async () => {
        const plugin = new SqlMacrosPlugin({ preventSelectStar: true })
        plugin.config = { role: 'admin' } as any

        await expect(
            plugin.beforeQuery({
                sql: 'SELECT * FROM users',
                dataSource: createMockDataSource(),
            })
        ).resolves.toEqual({
            sql: 'SELECT * FROM users',
            params: undefined,
        })
    })

    it('does not enforce SELECT * prevention when disabled', async () => {
        const plugin = new SqlMacrosPlugin({ preventSelectStar: false })
        plugin.config = { role: 'user' } as any

        await expect(
            plugin.beforeQuery({
                sql: 'SELECT * FROM users',
                dataSource: createMockDataSource(),
            })
        ).resolves.toEqual({
            sql: 'SELECT * FROM users',
            params: undefined,
        })
    })

    it('leaves $_exclude SQL unchanged for non-internal data sources', async () => {
        const plugin = new SqlMacrosPlugin({ preventSelectStar: false })
        const dataSource = createMockDataSource({ source: 'postgres' })

        await expect(
            plugin.beforeQuery({
                sql: 'SELECT $_exclude(password) FROM users',
                dataSource,
            })
        ).resolves.toEqual({
            sql: 'SELECT $_exclude(password) FROM users',
            params: undefined,
        })
        expect(dataSource.rpc.executeQuery).not.toHaveBeenCalled()
    })

    it('leaves pragma table info queries unchanged', async () => {
        const plugin = new SqlMacrosPlugin({ preventSelectStar: false })
        const dataSource = createMockDataSource()

        await expect(
            plugin.beforeQuery({
                sql: "SELECT name FROM pragma_table_info('users')",
                dataSource,
            })
        ).resolves.toEqual({
            sql: "SELECT name FROM pragma_table_info('users')",
            params: undefined,
        })
        expect(dataSource.rpc.executeQuery).not.toHaveBeenCalled()
    })

    it('expands $_exclude into explicit internal table columns', async () => {
        const plugin = new SqlMacrosPlugin({ preventSelectStar: false })
        const dataSource = createMockDataSource({
            columns: ['id', 'name', 'email', 'password'],
        })

        const result = await plugin.beforeQuery({
            sql: 'SELECT $_exclude(password) FROM users',
            dataSource,
        })

        expect(dataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: expect.stringContaining("FROM pragma_table_info('users')"),
        })
        expect(result.sql).toContain('id')
        expect(result.sql).toContain('name')
        expect(result.sql).toContain('email')
        expect(result.sql).not.toContain('password')
        expect(result.params).toBeUndefined()
    })

    it('expands multiple excluded columns case-insensitively', async () => {
        const plugin = new SqlMacrosPlugin({ preventSelectStar: false })
        const dataSource = createMockDataSource({
            columns: ['id', 'name', 'email', 'password'],
        })

        const result = await plugin.beforeQuery({
            sql: 'SELECT $_exclude(password, EMAIL) FROM users',
            dataSource,
        })

        expect(result.sql).toContain('id')
        expect(result.sql).toContain('name')
        expect(result.sql).not.toContain('password')
        expect(result.sql).not.toContain('email')
    })

    it('logs parse errors and returns the original SQL', async () => {
        const plugin = new SqlMacrosPlugin({ preventSelectStar: false })
        const dataSource = createMockDataSource()
        const consoleError = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})

        await expect(
            plugin.beforeQuery({
                sql: 'SELECT $_exclude(password FROM users',
                dataSource,
            })
        ).resolves.toEqual({
            sql: 'SELECT $_exclude(password FROM users',
            params: undefined,
        })
        expect(consoleError).toHaveBeenCalledWith(
            'SQL parsing error:',
            expect.any(Error)
        )

        consoleError.mockRestore()
    })
})
