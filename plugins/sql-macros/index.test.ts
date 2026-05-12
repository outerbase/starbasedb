import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SqlMacrosPlugin } from './index'
import type { DataSource } from '../../src/types'

const createInternalDataSource = (columns = ['id', 'name', 'email']) =>
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

describe('SqlMacrosPlugin', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('stores the current config during registration middleware', async () => {
        const plugin = new SqlMacrosPlugin()
        const config = { role: 'admin' }
        const next = vi.fn()
        const app = {
            use: vi.fn((middleware) =>
                middleware({ get: vi.fn(() => config) }, next)
            ),
        } as any

        await plugin.register(app)

        expect(app.use).toHaveBeenCalledTimes(1)
        expect(plugin.config).toBe(config)
        expect(next).toHaveBeenCalled()
    })

    it('leaves queries unchanged when no data source is available', async () => {
        const plugin = new SqlMacrosPlugin({ preventSelectStar: true })

        await expect(
            plugin.beforeQuery({
                sql: 'SELECT * FROM users',
                params: [1],
            })
        ).resolves.toEqual({
            sql: 'SELECT * FROM users',
            params: [1],
        })
    })

    it('replaces $_exclude with explicit internal table columns', async () => {
        const plugin = new SqlMacrosPlugin()
        const dataSource = createInternalDataSource([
            'id',
            'name',
            'email',
            'created_at',
        ])

        const result = await plugin.beforeQuery({
            sql: 'SELECT $_exclude(email, created_at) FROM users',
            dataSource,
        })

        expect(dataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: expect.stringContaining("pragma_table_info('users')"),
        })
        expect(result.sql).toBe('SELECT `id`, `name` FROM `users`')
    })

    it('keeps non-internal, pragma, and non-select queries unchanged', async () => {
        const plugin = new SqlMacrosPlugin()
        const externalDataSource = {
            source: 'postgresql',
            rpc: { executeQuery: vi.fn() },
        } as unknown as DataSource
        const internalDataSource = createInternalDataSource()

        await expect(
            plugin.beforeQuery({
                sql: 'SELECT $_exclude(email) FROM users',
                dataSource: externalDataSource,
            })
        ).resolves.toEqual({
            sql: 'SELECT $_exclude(email) FROM users',
            params: undefined,
        })

        await expect(
            plugin.beforeQuery({
                sql: "SELECT name FROM pragma_table_info('users')",
                dataSource: internalDataSource,
            })
        ).resolves.toEqual({
            sql: "SELECT name FROM pragma_table_info('users')",
            params: undefined,
        })

        await expect(
            plugin.beforeQuery({
                sql: 'UPDATE users SET name = ? WHERE id = ?',
                params: ['Ada', 1],
                dataSource: internalDataSource,
            })
        ).resolves.toEqual({
            sql: 'UPDATE users SET name = ? WHERE id = ?',
            params: ['Ada', 1],
        })
    })

    it('blocks SELECT * for non-admin users when enabled', async () => {
        const plugin = new SqlMacrosPlugin({ preventSelectStar: true })
        plugin.config = { role: 'user' } as any

        await expect(
            plugin.beforeQuery({
                sql: 'SELECT * FROM users',
                dataSource: createInternalDataSource(),
            })
        ).rejects.toThrow(
            'SELECT * is not allowed. Please specify explicit columns.'
        )
    })

    it('allows SELECT * for admins and when prevention is disabled', async () => {
        const adminPlugin = new SqlMacrosPlugin({ preventSelectStar: true })
        adminPlugin.config = { role: 'admin' } as any

        await expect(
            adminPlugin.beforeQuery({
                sql: 'SELECT * FROM users',
                dataSource: createInternalDataSource(),
            })
        ).resolves.toEqual({
            sql: 'SELECT * FROM users',
            params: undefined,
        })

        const disabledPlugin = new SqlMacrosPlugin({ preventSelectStar: false })
        disabledPlugin.config = { role: 'user' } as any

        await expect(
            disabledPlugin.beforeQuery({
                sql: 'SELECT * FROM users',
                dataSource: createInternalDataSource(),
            })
        ).resolves.toEqual({
            sql: 'SELECT * FROM users',
            params: undefined,
        })
    })

    it('returns original SQL and logs when exclude schema lookup fails', async () => {
        const plugin = new SqlMacrosPlugin()
        const consoleErrorSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})
        const dataSource = createInternalDataSource()
        vi.mocked(dataSource.rpc.executeQuery).mockRejectedValueOnce(
            new Error('schema unavailable')
        )

        const result = await plugin.beforeQuery({
            sql: 'SELECT $_exclude(email) FROM users',
            dataSource,
        })

        expect(result.sql).toBe('SELECT $_exclude(email) FROM users')
        expect(consoleErrorSpy).toHaveBeenCalledWith(
            'SQL parsing error:',
            expect.any(Error)
        )
    })
})
