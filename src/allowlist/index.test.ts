import { describe, expect, test, vi } from 'vitest'

import { isQueryAllowed } from './index'

function createDataSource(allowlistRows: any[] = []) {
    const executeQuery = vi.fn(async ({ sql }: { sql: string }) => {
        if (sql.includes('tmp_allowlist_queries')) {
            return allowlistRows
        }
        if (sql.includes('tmp_allowlist_rejections')) {
            return []
        }
        throw new Error(`Unexpected SQL: ${sql}`)
    })

    return {
        source: 'primary',
        rpc: {
            executeQuery,
        },
    } as any
}

describe('isQueryAllowed', () => {
    test('allows queries when allowlist enforcement is disabled', async () => {
        const dataSource = createDataSource()

        await expect(
            isQueryAllowed({
                sql: 'SELECT * FROM users',
                isEnabled: false,
                dataSource,
                config: { role: 'user' } as any,
            })
        ).resolves.toBe(true)

        expect(dataSource.rpc.executeQuery).not.toHaveBeenCalled()
    })

    test('allows admin queries without loading the allowlist', async () => {
        const dataSource = createDataSource()

        await expect(
            isQueryAllowed({
                sql: 'DROP TABLE users',
                isEnabled: true,
                dataSource,
                config: { role: 'admin' } as any,
            })
        ).resolves.toBe(true)

        expect(dataSource.rpc.executeQuery).not.toHaveBeenCalled()
    })

    test('matches allowlisted SQL with a trailing semicolon', async () => {
        const dataSource = createDataSource([
            {
                sql_statement: 'SELECT id, name FROM users WHERE active = true',
                source: 'primary',
            },
            {
                sql_statement: 'SELECT * FROM ignored',
                source: 'replica',
            },
        ])

        await expect(
            isQueryAllowed({
                sql: 'SELECT id, name FROM users WHERE active = true;',
                isEnabled: true,
                dataSource,
                config: { role: 'user' } as any,
            })
        ).resolves.toBe(true)

        expect(dataSource.rpc.executeQuery).toHaveBeenCalledTimes(1)
    })

    test('rejects non-allowlisted SQL and records the rejected query', async () => {
        const dataSource = createDataSource([
            {
                sql_statement: 'SELECT id FROM users',
                source: 'primary',
            },
        ])

        await expect(
            isQueryAllowed({
                sql: 'SELECT email FROM users',
                isEnabled: true,
                dataSource,
                config: { role: 'user' } as any,
            })
        ).rejects.toThrow('Query not allowed')

        expect(dataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: 'INSERT INTO tmp_allowlist_rejections (sql_statement, source) VALUES (?, ?)',
            params: ['SELECT email FROM users', 'primary'],
        })
    })

    test('returns a helpful error when SQL is missing', async () => {
        const dataSource = createDataSource()

        const result = await isQueryAllowed({
            sql: '',
            isEnabled: true,
            dataSource,
            config: { role: 'user' } as any,
        })

        expect(result).toBeInstanceOf(Error)
        expect((result as Error).message).toBe(
            'No SQL provided for allowlist check'
        )
    })
})
