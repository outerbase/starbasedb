import { describe, expect, it, vi } from 'vitest'
import { isQueryAllowed } from './index'
import type { DataSource } from '../types'

function createDataSource(allowedQueries: string[] = []) {
    const rejections: Array<{ sql: string; params?: unknown[] }> = []

    const dataSource = {
        source: 'internal',
        rpc: {
            executeQuery: vi.fn(async ({ sql, params }) => {
                if (sql.startsWith('SELECT sql_statement')) {
                    return allowedQueries.map((sql_statement) => ({
                        sql_statement,
                        source: 'internal',
                    }))
                }

                if (sql.startsWith('INSERT INTO tmp_allowlist_rejections')) {
                    rejections.push({ sql, params })
                    return [{ sql_statement: params?.[0] }]
                }

                return []
            }),
        },
    } as unknown as DataSource

    return { dataSource, rejections }
}

describe('isQueryAllowed', () => {
    it('allows queries when the allowlist feature is disabled', async () => {
        const { dataSource } = createDataSource()

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

    it('allows admin requests without loading the allowlist', async () => {
        const { dataSource } = createDataSource()

        await expect(
            isQueryAllowed({
                sql: 'DELETE FROM users',
                isEnabled: true,
                dataSource,
                config: { role: 'admin' } as any,
            })
        ).resolves.toBe(true)

        expect(dataSource.rpc.executeQuery).not.toHaveBeenCalled()
    })

    it('allows matching queries even when the submitted query has a trailing semicolon', async () => {
        const { dataSource } = createDataSource(['SELECT * FROM users'])

        await expect(
            isQueryAllowed({
                sql: 'SELECT * FROM users;',
                isEnabled: true,
                dataSource,
                config: { role: 'user' } as any,
            })
        ).resolves.toBe(true)
    })

    it('rejects and records queries that are not in the allowlist', async () => {
        const { dataSource, rejections } = createDataSource([
            'SELECT * FROM users',
        ])

        await expect(
            isQueryAllowed({
                sql: 'SELECT * FROM projects',
                isEnabled: true,
                dataSource,
                config: { role: 'user' } as any,
            })
        ).rejects.toThrow('Query not allowed')

        expect(rejections).toEqual([
            {
                sql: 'INSERT INTO tmp_allowlist_rejections (sql_statement, source) VALUES (?, ?)',
                params: ['SELECT * FROM projects', 'internal'],
            },
        ])
    })

    it('returns an error for missing SQL input before attempting to parse it', async () => {
        const { dataSource, rejections } = createDataSource([
            'SELECT * FROM users',
        ])

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
        expect(rejections).toEqual([])
    })
})
