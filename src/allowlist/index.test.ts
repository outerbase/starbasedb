import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { isQueryAllowed } from './index'
import type { DataSource } from '../types'
import type { StarbaseDBConfiguration } from '../handler'

type AllowlistRow = { source: string; sql_statement: string }

let dataSource: DataSource
let config: StarbaseDBConfiguration

function createDataSource(): DataSource {
    return {
        source: 'external',
        external: { dialect: 'sqlite' },
        rpc: {
            executeQuery: vi.fn(),
        },
    } as any
}

function createConfig(
    overrides: Partial<StarbaseDBConfiguration> = {}
): StarbaseDBConfiguration {
    return {
        outerbaseApiKey: 'mock-api-key',
        role: 'client',
        features: { allowlist: true, rls: false, rest: true },
        ...overrides,
    }
}

function mockAllowlist(
    rows: AllowlistRow[],
    options: { loadError?: Error; rejectionError?: Error } = {}
) {
    const executeQuery = vi.mocked(dataSource.rpc.executeQuery)

    executeQuery.mockImplementation((async ({ sql }: any) => {
        if (String(sql).includes('SELECT sql_statement')) {
            if (options.loadError) throw options.loadError
            return rows
        }

        if (options.rejectionError) throw options.rejectionError
        return []
    }) as any)

    return executeQuery
}

function callIsQueryAllowed(sql: string, isEnabled = true) {
    return isQueryAllowed({ sql, isEnabled, dataSource, config })
}

beforeEach(() => {
    dataSource = createDataSource()
    config = createConfig()
})

afterEach(() => {
    vi.restoreAllMocks()
})

describe('isQueryAllowed - bypasses', () => {
    it('allows every query without touching the database when the allowlist feature is disabled', async () => {
        const executeQuery = mockAllowlist([])

        const result = await callIsQueryAllowed('DROP TABLE users', false)

        expect(result).toBe(true)
        expect(executeQuery).not.toHaveBeenCalled()
    })

    it('allows every query without touching the database for the admin role', async () => {
        config = createConfig({ role: 'admin' })
        const executeQuery = mockAllowlist([
            { source: 'external', sql_statement: 'SELECT * FROM users' },
        ])

        const result = await callIsQueryAllowed('DROP TABLE users')

        expect(result).toBe(true)
        expect(executeQuery).not.toHaveBeenCalled()
    })

    it('checks the allowlist for a client role instead of bypassing it', async () => {
        const executeQuery = mockAllowlist([])

        await expect(callIsQueryAllowed('SELECT * FROM users')).rejects.toThrow(
            'Query not allowed'
        )
        expect(executeQuery).toHaveBeenCalled()
    })
})

describe('isQueryAllowed - valid input', () => {
    it('allows a query that exactly matches an allowlist entry', async () => {
        mockAllowlist([
            { source: 'external', sql_statement: 'SELECT id, name FROM users' },
        ])

        await expect(
            callIsQueryAllowed('SELECT id, name FROM users')
        ).resolves.toBe(true)
    })

    it('treats a trailing semicolon and surrounding whitespace as equivalent', async () => {
        mockAllowlist([
            { source: 'external', sql_statement: 'SELECT * FROM users;' },
        ])

        await expect(
            callIsQueryAllowed('  SELECT * FROM users ;  ')
        ).resolves.toBe(true)
    })

    it('allows an allowed query containing a -1 literal', async () => {
        mockAllowlist([
            {
                source: 'external',
                sql_statement: 'SELECT * FROM users WHERE id = -1',
            },
        ])

        await expect(
            callIsQueryAllowed('SELECT * FROM users WHERE id = -1')
        ).resolves.toBe(true)
    })

    it('allows an allowed query containing a NULL comparison', async () => {
        mockAllowlist([
            {
                source: 'external',
                sql_statement: 'SELECT * FROM users WHERE deleted_at IS NULL',
            },
        ])

        await expect(
            callIsQueryAllowed('SELECT * FROM users WHERE deleted_at IS NULL')
        ).resolves.toBe(true)
    })

    it('records the rejection against the correct data source', async () => {
        const executeQuery = mockAllowlist([
            { source: 'external', sql_statement: 'SELECT * FROM users' },
        ])

        await expect(
            callIsQueryAllowed('SELECT * FROM orders')
        ).rejects.toThrow('Query not allowed')

        expect(executeQuery).toHaveBeenCalledWith({
            sql: 'INSERT INTO tmp_allowlist_rejections (sql_statement, source) VALUES (?, ?)',
            params: ['SELECT * FROM orders', 'external'],
        })
    })
})

describe('isQueryAllowed - invalid input', () => {
    it('rejects a query against a table that is not on the allowlist', async () => {
        mockAllowlist([
            { source: 'external', sql_statement: 'SELECT * FROM users' },
        ])

        await expect(
            callIsQueryAllowed('SELECT * FROM fake_table_xyz')
        ).rejects.toThrow('Query not allowed')
    })

    it('rejects a stacked statement appended to an allowed query', async () => {
        mockAllowlist([
            { source: 'external', sql_statement: 'SELECT * FROM users' },
        ])

        await expect(
            callIsQueryAllowed('SELECT * FROM users; DROP TABLE users')
        ).rejects.toThrow('Query not allowed')
    })

    it('rejects a query whose literal values differ from the allowlist entry', async () => {
        mockAllowlist([
            {
                source: 'external',
                sql_statement: 'SELECT * FROM users WHERE id = 1',
            },
        ])

        await expect(
            callIsQueryAllowed('SELECT * FROM users WHERE id = 2')
        ).rejects.toThrow('Query not allowed')
    })

    it('ignores allowlist rows that belong to a different data source', async () => {
        mockAllowlist([
            { source: 'internal', sql_statement: 'SELECT * FROM users' },
        ])

        await expect(callIsQueryAllowed('SELECT * FROM users')).rejects.toThrow(
            'Query not allowed'
        )
    })

    it('surfaces the parser error for malformed SQL', async () => {
        mockAllowlist([
            { source: 'external', sql_statement: 'SELECT * FROM users' },
        ])

        await expect(callIsQueryAllowed('SELECT FROM')).rejects.toThrow(
            /Expected/
        )
    })
})

describe('isQueryAllowed - omitted input', () => {
    it('returns an Error when the SQL string is empty', async () => {
        mockAllowlist([
            { source: 'external', sql_statement: 'SELECT * FROM users' },
        ])

        const result = await callIsQueryAllowed('')

        expect(result).toBeInstanceOf(Error)
        expect((result as Error).message).toBe(
            'No SQL provided for allowlist check'
        )
    })

    it('returns an Error when the SQL is missing entirely', async () => {
        mockAllowlist([
            { source: 'external', sql_statement: 'SELECT * FROM users' },
        ])

        const result = await callIsQueryAllowed(undefined as any)

        expect(result).toBeInstanceOf(Error)
        expect((result as Error).message).toBe(
            'No SQL provided for allowlist check'
        )
    })

    it('does not allow a whitespace-only query', async () => {
        mockAllowlist([
            { source: 'external', sql_statement: 'SELECT * FROM users' },
        ])

        await expect(callIsQueryAllowed('   ')).rejects.toThrow(
            'Query not allowed'
        )
    })
})

describe('isQueryAllowed - error handling', () => {
    it('falls back to rejecting queries when the allowlist cannot be loaded', async () => {
        const consoleError = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})
        mockAllowlist([], { loadError: new Error('database offline') })

        await expect(callIsQueryAllowed('SELECT * FROM users')).rejects.toThrow(
            'Query not allowed'
        )
        expect(consoleError).toHaveBeenCalledWith(
            'Error loading allowlist:',
            expect.any(Error)
        )
    })

    it('still rejects a query when recording the rejection fails', async () => {
        const consoleError = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})
        mockAllowlist(
            [{ source: 'external', sql_statement: 'SELECT * FROM users' }],
            { rejectionError: new Error('insert failed') }
        )

        await expect(callIsQueryAllowed('DROP TABLE users')).rejects.toThrow(
            'Query not allowed'
        )
        expect(consoleError).toHaveBeenCalledWith(
            'Error inserting rejected allowlist query:',
            expect.any(Error)
        )
    })

    it('allows the query when the allowlist table is unavailable but the feature is disabled', async () => {
        const executeQuery = mockAllowlist([], {
            loadError: new Error('database offline'),
        })

        await expect(
            callIsQueryAllowed('SELECT * FROM users', false)
        ).resolves.toBe(true)
        expect(executeQuery).not.toHaveBeenCalled()
    })
})
