import { describe, it, expect, vi, beforeEach } from 'vitest'
import { isQueryAllowed } from './index'
import { StarbaseDBConfiguration } from '../handler'

const mockDataSource = {
    source: 'internal',
    rpc: {
        executeQuery: vi.fn(),
    },
} as any

const clientConfig: StarbaseDBConfiguration = {
    role: 'client',
    features: { allowlist: true },
}

const adminConfig: StarbaseDBConfiguration = {
    role: 'admin',
    features: { allowlist: true },
}

function mockAllowlistRows(rows: { sql_statement: string; source: string }[]) {
    vi.mocked(mockDataSource.rpc.executeQuery).mockImplementation(
        async (opts: any) => {
            const sql: string = opts?.sql ?? ''
            if (sql.startsWith('SELECT')) {
                return rows as any
            }
            // INSERT into rejections — record call, return empty
            return [] as any
        }
    )
}

describe('isQueryAllowed - allowlist query checker', () => {
    beforeEach(() => {
        vi.resetAllMocks()
        vi.spyOn(console, 'error').mockImplementation(() => {})
    })

    it('allows any query when the feature is disabled without touching the DB', async () => {
        const result = await isQueryAllowed({
            sql: 'DROP TABLE users',
            isEnabled: false,
            dataSource: mockDataSource,
            config: clientConfig,
        })

        expect(result).toBe(true)
        expect(mockDataSource.rpc.executeQuery).not.toHaveBeenCalled()
    })

    it('allows any query for admin role without touching the DB', async () => {
        const result = await isQueryAllowed({
            sql: 'DELETE FROM users',
            isEnabled: true,
            dataSource: mockDataSource,
            config: adminConfig,
        })

        expect(result).toBe(true)
        expect(mockDataSource.rpc.executeQuery).not.toHaveBeenCalled()
    })

    it('allows an exact allowlisted query', async () => {
        mockAllowlistRows([
            { sql_statement: 'SELECT * FROM users', source: 'internal' },
        ])

        const result = await isQueryAllowed({
            sql: 'SELECT * FROM users',
            isEnabled: true,
            dataSource: mockDataSource,
            config: clientConfig,
        })

        expect(result).toBe(true)
    })

    it('treats trailing semicolon as equivalent (normalizeSQL)', async () => {
        mockAllowlistRows([
            { sql_statement: 'SELECT * FROM users', source: 'internal' },
        ])

        const result = await isQueryAllowed({
            sql: 'SELECT * FROM users;',
            isEnabled: true,
            dataSource: mockDataSource,
            config: clientConfig,
        })

        expect(result).toBe(true)
    })

    it('ignores allowlist rows from other sources', async () => {
        mockAllowlistRows([
            { sql_statement: 'SELECT * FROM users', source: 'external' },
            { sql_statement: 'SELECT id FROM orders', source: 'internal' },
        ])

        const allowed = await isQueryAllowed({
            sql: 'SELECT id FROM orders',
            isEnabled: true,
            dataSource: mockDataSource,
            config: clientConfig,
        })
        expect(allowed).toBe(true)

        await expect(
            isQueryAllowed({
                sql: 'SELECT * FROM users',
                isEnabled: true,
                dataSource: mockDataSource,
                config: clientConfig,
            })
        ).rejects.toThrow('Query not allowed')
    })

    it('rejects non-allowlisted query, logs rejection, and throws', async () => {
        mockAllowlistRows([
            { sql_statement: 'SELECT * FROM users', source: 'internal' },
        ])

        await expect(
            isQueryAllowed({
                sql: 'DROP TABLE users',
                isEnabled: true,
                dataSource: mockDataSource,
                config: clientConfig,
            })
        ).rejects.toThrow('Query not allowed')

        // SELECT for load + INSERT for rejection audit
        const calls = vi.mocked(mockDataSource.rpc.executeQuery).mock.calls
        expect(calls.length).toBeGreaterThanOrEqual(2)
        expect(String(calls[1][0]?.sql)).toContain('INSERT INTO tmp_allowlist_rejections')
        expect(calls[1][0]?.params).toEqual(['DROP TABLE users', 'internal'])
    })

    it('returns an Error object when SQL is missing', async () => {
        mockAllowlistRows([
            { sql_statement: 'SELECT * FROM users', source: 'internal' },
        ])

        const result = await isQueryAllowed({
            sql: '',
            isEnabled: true,
            dataSource: mockDataSource,
            config: clientConfig,
        })

        expect(result).toBeInstanceOf(Error)
        expect((result as Error).message).toContain('No SQL provided')
    })

    it('denies when allowlist fails to load (empty list fail-closed)', async () => {
        vi.mocked(mockDataSource.rpc.executeQuery).mockImplementation(
            async (opts: any) => {
                if (String(opts?.sql).startsWith('SELECT')) {
                    throw new Error('Database error')
                }
                return [] as any
            }
        )

        await expect(
            isQueryAllowed({
                sql: 'SELECT * FROM users',
                isEnabled: true,
                dataSource: mockDataSource,
                config: clientConfig,
            })
        ).rejects.toThrow('Query not allowed')
    })

    it('still rejects cleanly when rejection audit insert fails', async () => {
        vi.mocked(mockDataSource.rpc.executeQuery).mockImplementation(
            async (opts: any) => {
                const sql: string = opts?.sql ?? ''
                if (sql.startsWith('SELECT')) {
                    return [
                        { sql_statement: 'SELECT * FROM users', source: 'internal' },
                    ] as any
                }
                throw new Error('audit table missing')
            }
        )

        await expect(
            isQueryAllowed({
                sql: 'SELECT * FROM secrets',
                isEnabled: true,
                dataSource: mockDataSource,
                config: clientConfig,
            })
        ).rejects.toThrow('Query not allowed')
    })
})
