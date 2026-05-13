import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isQueryAllowed } from './index'
import { DataSource } from '../types'

const createDataSource = (rows: unknown[] = []): DataSource =>
    ({
        source: 'internal',
        rpc: {
            executeQuery: vi.fn().mockResolvedValue(rows),
        },
    }) as unknown as DataSource

describe('Allowlist Module', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('allows queries when allowlist enforcement is disabled', async () => {
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

    it('allows admin requests without loading allowlist entries', async () => {
        const dataSource = createDataSource()

        await expect(
            isQueryAllowed({
                sql: 'DELETE FROM users WHERE id = 1',
                isEnabled: true,
                dataSource,
                config: { role: 'admin' } as any,
            })
        ).resolves.toBe(true)

        expect(dataSource.rpc.executeQuery).not.toHaveBeenCalled()
    })

    it('allows structurally matching queries with different literal values', async () => {
        const dataSource = createDataSource([
            {
                sql_statement: 'SELECT * FROM users WHERE id = 1',
                source: 'internal',
            },
        ])

        await expect(
            isQueryAllowed({
                sql: 'SELECT * FROM users WHERE id = 42',
                isEnabled: true,
                dataSource,
                config: { role: 'user' } as any,
            })
        ).resolves.toBe(true)
    })

    it('normalizes trailing semicolons before comparing queries', async () => {
        const dataSource = createDataSource([
            {
                sql_statement: 'SELECT * FROM users WHERE id = 1',
                source: 'internal',
            },
        ])

        await expect(
            isQueryAllowed({
                sql: 'SELECT * FROM users WHERE id = 1;',
                isEnabled: true,
                dataSource,
                config: { role: 'user' } as any,
            })
        ).resolves.toBe(true)
    })

    it('records rejected queries before returning a query-not-allowed error', async () => {
        const dataSource = createDataSource([
            {
                sql_statement: 'SELECT * FROM users WHERE id = 1',
                source: 'internal',
            },
        ])

        await expect(
            isQueryAllowed({
                sql: 'SELECT email FROM users WHERE id = 1',
                isEnabled: true,
                dataSource,
                config: { role: 'user' } as any,
            })
        ).rejects.toThrow('Query not allowed')

        expect(dataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: 'INSERT INTO tmp_allowlist_rejections (sql_statement, source) VALUES (?, ?)',
            params: ['SELECT email FROM users WHERE id = 1', 'internal'],
        })
    })
})
