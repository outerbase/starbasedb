import { describe, it, expect, vi } from 'vitest'
import { isQueryAllowed } from './index'
import { DataSource } from '../types'
import { StarbaseDBConfiguration } from '../handler'

describe('isQueryAllowed', () => {
    const createMockDataSource = (rows: any[] = []): DataSource => ({
        source: 'main',
        rpc: {
            executeQuery: vi.fn().mockResolvedValue(rows),
            executeBatch: vi.fn(),
        },
    })

    it('returns true immediately when allowlist is disabled', async () => {
        const ds = createMockDataSource()
        const result = await isQueryAllowed({
            sql: 'SELECT * FROM users',
            isEnabled: false,
            dataSource: ds,
            config: { role: 'user' } as StarbaseDBConfiguration,
        })
        expect(result).toBe(true)
    })

    it('returns true immediately when role is admin', async () => {
        const ds = createMockDataSource()
        const result = await isQueryAllowed({
            sql: 'DROP TABLE users',
            isEnabled: true,
            dataSource: ds,
            config: { role: 'admin' } as StarbaseDBConfiguration,
        })
        expect(result).toBe(true)
    })

    it('allows matching SQL query regardless of trailing semicolon', async () => {
        const ds = createMockDataSource([
            { sql_statement: 'SELECT id, name FROM users', source: 'main' },
        ])
        const result = await isQueryAllowed({
            sql: 'SELECT id, name FROM users;',
            isEnabled: true,
            dataSource: ds,
            config: { role: 'user' } as StarbaseDBConfiguration,
        })
        expect(result).toBe(true)
    })

    it('throws Query not allowed for unlisted SQL statement', async () => {
        const ds = createMockDataSource([
            { sql_statement: 'SELECT id FROM users', source: 'main' },
        ])
        await expect(
            isQueryAllowed({
                sql: 'DELETE FROM users',
                isEnabled: true,
                dataSource: ds,
                config: { role: 'user' } as StarbaseDBConfiguration,
            })
        ).rejects.toThrow('Query not allowed')
    })
})
