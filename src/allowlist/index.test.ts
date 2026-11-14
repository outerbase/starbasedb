import { describe, expect, it, vi } from 'vitest'
import { isQueryAllowed } from './index'
import { DataSource } from '../types'
import { StarbaseDBConfiguration } from '../handler'

function createMockDataSource(
    allowedQueries: Array<{ sql_statement: string; source: string }> = [],
    source = 'internal'
): DataSource {
    return {
        source,
        rpc: {
            executeQuery: vi.fn(async ({ sql }: { sql: string; params?: any[] }) => {
                if (sql.includes('SELECT sql_statement, source FROM tmp_allowlist_queries')) {
                    return allowedQueries
                }
                return []
            }),
            executeTransaction: vi.fn(async () => []),
            setAlarm: vi.fn(async () => {}),
            getAlarm: vi.fn(async () => null),
            deleteAlarm: vi.fn(async () => {}),
            getStatistics: vi.fn(async () => ({})),
        } as any,
    }
}

describe('Allowlist (src/allowlist/index.ts)', () => {
    const userConfig: StarbaseDBConfiguration = {
        role: 'user',
    } as any

    const adminConfig: StarbaseDBConfiguration = {
        role: 'admin',
    } as any

    it('allows any query when allowlist is disabled', async () => {
        const ds = createMockDataSource()
        const allowed = await isQueryAllowed({
            sql: 'DROP TABLE users;',
            isEnabled: false,
            dataSource: ds,
            config: userConfig,
        })
        expect(allowed).toBe(true)
        expect(ds.rpc.executeQuery).not.toHaveBeenCalled()
    })

    it('allows any query when user role is admin', async () => {
        const ds = createMockDataSource()
        const allowed = await isQueryAllowed({
            sql: 'DELETE FROM users',
            isEnabled: true,
            dataSource: ds,
            config: adminConfig,
        })
        expect(allowed).toBe(true)
        expect(ds.rpc.executeQuery).not.toHaveBeenCalled()
    })

    it('allows query matching AST in allowlist even with trailing semicolon difference', async () => {
        const ds = createMockDataSource([
            {
                sql_statement: 'SELECT id, name FROM users WHERE id = 1',
                source: 'internal',
            },
        ])
        const allowed = await isQueryAllowed({
            sql: 'SELECT id, name FROM users WHERE id = 1;',
            isEnabled: true,
            dataSource: ds,
            config: userConfig,
        })
        expect(allowed).toBe(true)
    })

    it('rejects non-matching query and logs it into tmp_allowlist_rejections', async () => {
        const ds = createMockDataSource([
            {
                sql_statement: 'SELECT id FROM users',
                source: 'internal',
            },
        ])

        await expect(
            isQueryAllowed({
                sql: 'SELECT id, secret FROM users',
                isEnabled: true,
                dataSource: ds,
                config: userConfig,
            })
        ).rejects.toThrow('Query not allowed')

        expect(ds.rpc.executeQuery).toHaveBeenCalledWith({
            sql: 'INSERT INTO tmp_allowlist_rejections (sql_statement, source) VALUES (?, ?)',
            params: ['SELECT id, secret FROM users', 'internal'],
        })
    })

    it('returns an Error object when sql is empty', async () => {
        const ds = createMockDataSource([])
        const res = await isQueryAllowed({
            sql: '',
            isEnabled: true,
            dataSource: ds,
            config: userConfig,
        })
        expect(res).toBeInstanceOf(Error)
        expect((res as Error).message).toContain('No SQL provided')
    })
})
