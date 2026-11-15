
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { isQueryAllowed } from './index'
import { StarbaseDBConfiguration } from '../handler'
import { DataSource, QueryResult } from '../types'

function makeDataSource(rows: QueryResult[] = [], rpcError?: Error): DataSource {
    const executeQuery = vi.fn(async () => {
        if (rpcError) throw rpcError
        return rows
    })
    return {
        source: 'SUPABASE',
        rpc: { executeQuery },
    } as unknown as DataSource
}

function makeConfig(role?: string): StarbaseDBConfiguration {
    return { role } as unknown as StarbaseDBConfiguration
}

const SELECT_ROWS: QueryResult[] = [
    { sql_statement: 'SELECT * FROM users', source: 'SUPABASE' },
    { sql_statement: 'INSERT INTO logs (msg) VALUES (?)', source: 'SUPABASE' },
    { sql_statement: 'SELECT * FROM other_source_table', source: 'OTHER' },
]

describe('isQueryAllowed', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
    })

    it('allows any query when the allowlist feature is disabled', async () => {
        const ds = makeDataSource([])
        const result = await isQueryAllowed({
            sql: 'DROP TABLE users',
            isEnabled: false,
            dataSource: ds,
            config: makeConfig(),
        })
        expect(result).toBe(true)
    })

    it('allows any query for the admin role', async () => {
        const ds = makeDataSource([])
        const result = await isQueryAllowed({
            sql: 'DROP TABLE users',
            isEnabled: true,
            dataSource: ds,
            config: makeConfig('admin'),
        })
        expect(result).toBe(true)
    })

    it('allows a query that exactly matches an allowlist entry', async () => {
        const ds = makeDataSource(SELECT_ROWS)
        const result = await isQueryAllowed({
            sql: 'SELECT * FROM users',
            isEnabled: true,
            dataSource: ds,
            config: makeConfig(),
        })
        expect(result).toBe(true)
    })

    it('allows a query matching an allowlist entry despite trailing semicolon and whitespace', async () => {
        const ds = makeDataSource(SELECT_ROWS)
        const result = await isQueryAllowed({
            sql: '  SELECT * FROM users ;  ',
            isEnabled: true,
            dataSource: ds,
            config: makeConfig(),
        })
        expect(result).toBe(true)
    })

    it('rejects a query that is not on the allowlist and logs the rejection', async () => {
        const ds = makeDataSource(SELECT_ROWS)
        await expect(
            isQueryAllowed({
                sql: 'DELETE FROM users',
                isEnabled: true,
                dataSource: ds,
                config: makeConfig(),
            })
        ).rejects.toThrow('Query not allowed')

        // The rejected query should have been recorded in the audit table
        const insertCall = (ds.rpc.executeQuery as ReturnType<typeof vi.fn>).mock.calls.find(
            (c: any[]) => String(c[0]?.sql ?? '').includes('tmp_allowlist_rejections')
        )
        expect(insertCall).toBeDefined()
        expect(insertCall![0].params).toEqual(['DELETE FROM users', 'SUPABASE'])
    })

    it('rejects empty SQL with an error', async () => {
        const ds = makeDataSource(SELECT_ROWS)
        await expect(
            isQueryAllowed({
                sql: '',
                isEnabled: true,
                dataSource: ds,
                config: makeConfig(),
            })
        ).rejects.toThrow('No SQL provided for allowlist check')
    })

    it('rejects everything when the allowlist cannot be loaded (rpc error)', async () => {
        const ds = makeDataSource([], new Error('boom'))
        await expect(
            isQueryAllowed({
                sql: 'SELECT * FROM users',
                isEnabled: true,
                dataSource: ds,
                config: makeConfig(),
            })
        ).rejects.toThrow('Query not allowed')
    })

    it('only considers allowlist entries matching the current data source', async () => {
        // Only an OTHER-source entry exists; SUPABASE queries must still be rejected
        const ds = makeDataSource([
            { sql_statement: 'SELECT * FROM users', source: 'OTHER' },
        ])
        await expect(
            isQueryAllowed({
                sql: 'SELECT * FROM users',
                isEnabled: true,
                dataSource: ds,
                config: makeConfig(),
            })
        ).rejects.toThrow('Query not allowed')
    })
})
