import { describe, it, expect, vi, beforeEach } from 'vitest'
import { applyRLS, loadPolicies } from './index'
import { DataSource, QueryResult } from '../types'
import { StarbaseDBConfiguration } from '../handler'

const mockDataSource = {
    source: 'internal',
    rpc: {
        executeQuery: vi.fn(),
    },
    context: { sub: 'user123' },
} as any

const mockConfig: StarbaseDBConfiguration = {
    outerbaseApiKey: 'mock-api-key',
    role: 'client',
    features: { allowlist: true, rls: true, rest: true },
}

describe('loadPolicies - Policy Fetching and Parsing', () => {
    it('should load and parse policies correctly', async () => {
        vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValue([
            {
                actions: 'SELECT',
                schema: 'public',
                table: 'users',
                column: 'user_id',
                value: 'context.id()',
                value_type: 'string',
                operator: '=',
            },
        ] as any)

        const policies = await loadPolicies(mockDataSource)

        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledTimes(1)
        expect(policies).toEqual([
            {
                action: 'SELECT',
                condition: {
                    type: 'binary_expr',
                    operator: '=',
                    left: {
                        type: 'column_ref',
                        table: 'public.users',
                        column: 'user_id',
                    },
                    right: {
                        type: 'string',
                        value: '__CONTEXT_ID__',
                    },
                },
            },
        ])
    })

    it('should treat an empty policy table as a load failure', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValue([])

        const policies = await loadPolicies(mockDataSource)
        expect(policies).toEqual([])
    })

    it('should normalize quoted identifiers and numeric values', async () => {
        vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValue([
            {
                actions: 'select',
                schema: '"public"',
                table: '`users`',
                column: '"user_id"',
                value: '7',
                value_type: 'number',
                operator: '=',
            },
        ] as any)

        const policies = await loadPolicies(mockDataSource)
        expect(policies[0].condition.left.table).toBe('public.users')
        expect(policies[0].condition.left.column).toBe('user_id')
        expect(policies[0].condition.right.value).toBe(7)
    })

    it('should return an empty array if an error occurs', async () => {
        const consoleErrorSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})
        vi.mocked(mockDataSource.rpc.executeQuery).mockRejectedValue(
            new Error('Database error')
        )

        const policies = await loadPolicies(mockDataSource)

        expect(policies).toEqual([])
    })
})

function selectPolicy(overrides: Record<string, unknown> = {}) {
    return {
        actions: 'SELECT',
        schema: 'public',
        table: 'users',
        column: 'user_id',
        value: 'context.id()',
        value_type: 'string',
        operator: '=',
        ...overrides,
    }
}

describe('applyRLS - Query Modification', () => {
    beforeEach(() => {
        vi.resetAllMocks()
        mockConfig.role = 'client'
        mockDataSource.context.sub = 'user123'
        vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValue([
            selectPolicy(),
        ])
    })

    it('should modify SELECT queries with WHERE conditions', async () => {
        const sql = 'SELECT * FROM users'
        const modifiedSql = await applyRLS({
            sql,
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(modifiedSql.toUpperCase()).toContain('WHERE')
        expect(modifiedSql).toContain('user_id')
        expect(modifiedSql).toContain('user123')
    })
    it('should modify DELETE queries by adding policy-based WHERE clause', async () => {
        vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValue([
            selectPolicy({ actions: 'DELETE' }),
        ])

        const sql = "DELETE FROM users WHERE name = 'Alice'"
        const modifiedSql = await applyRLS({
            sql,
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(modifiedSql).toContain('name')
        expect(modifiedSql).toContain('Alice')
        expect(modifiedSql).toContain('user_id')
        expect(modifiedSql).toContain('user123')
    })

    it('should modify UPDATE queries with additional WHERE clause', async () => {
        vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValue([
            selectPolicy({ actions: 'UPDATE' }),
        ])

        const sql = "UPDATE users SET name = 'Bob' WHERE age = 25"
        const modifiedSql = await applyRLS({
            sql,
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(modifiedSql).toContain('Bob')
        expect(modifiedSql).toContain('age')
        expect(modifiedSql).toContain('user_id')
        expect(modifiedSql).toContain('user123')
    })

    it('should modify INSERT queries to enforce column values', async () => {
        vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValue([
            selectPolicy({ actions: 'INSERT' }),
        ])

        const sql = "INSERT INTO users (user_id, name) VALUES (1, 'Alice')"
        const modifiedSql = await applyRLS({
            sql,
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(modifiedSql).toContain('Alice')
        expect(modifiedSql).toContain('user123')
    })

    it('should deny mutating a restricted table without a matching action policy', async () => {
        await expect(
            applyRLS({
                sql: "DELETE FROM users WHERE name = 'Alice'",
                isEnabled: true,
                dataSource: mockDataSource,
                config: mockConfig,
            })
        ).rejects.toThrow(/Unauthorized access: No matching rules for DELETE/)
    })
})

describe('applyRLS - Edge Cases', () => {
    beforeEach(() => {
        mockConfig.role = 'client'
        mockDataSource.context.sub = 'user123'
    })

    it('should not modify SQL if RLS is disabled', async () => {
        const sql = 'SELECT * FROM users'
        const modifiedSql = await applyRLS({
            sql,
            isEnabled: false,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(modifiedSql).toBe(sql)
    })

    it('should not modify SQL if user is admin', async () => {
        mockConfig.role = 'admin'

        const sql = 'SELECT * FROM users'
        const modifiedSql = await applyRLS({
            sql,
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(modifiedSql).toBe(sql)
    })

    it('should throw when SQL is omitted', async () => {
        await expect(
            applyRLS({
                sql: '',
                isEnabled: true,
                dataSource: mockDataSource,
                config: mockConfig,
            })
        ).rejects.toThrow('No SQL query found in RLS plugin.')
    })

    it('should not leak policies across schemas', async () => {
        vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValue([
            selectPolicy({ schema: 'public', table: 'users' }),
        ])

        const modifiedSql = await applyRLS({
            sql: 'SELECT * FROM other.users',
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(modifiedSql).not.toContain('user123')
    })

    it('should cast numeric policy values', async () => {
        vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValue([
            selectPolicy({
                value: '42',
                value_type: 'number',
            }),
        ])

        const modifiedSql = await applyRLS({
            sql: 'SELECT * FROM users',
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(modifiedSql).toContain('42')
    })

    it('should return SQL unchanged when no policies can be loaded', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        vi.mocked(mockDataSource.rpc.executeQuery).mockRejectedValue(
            new Error('Database error')
        )

        const sql = 'SELECT * FROM users'
        const modifiedSql = await applyRLS({
            sql,
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(modifiedSql.toUpperCase()).toContain('SELECT')
        expect(modifiedSql).not.toContain('user123')
    })
})

describe('applyRLS - Multi-Table Queries', () => {
    beforeEach(() => {
        mockConfig.role = 'client'
        mockDataSource.context.sub = 'user123'
        vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValue([
            {
                actions: 'SELECT',
                schema: 'public',
                table: 'users',
                column: 'user_id',
                value: 'context.id()',
                value_type: 'string',
                operator: '=',
            },
            {
                actions: 'SELECT',
                schema: 'public',
                table: 'orders',
                column: 'user_id',
                value: 'context.id()',
                value_type: 'string',
                operator: '=',
            },
        ] as any)
    })

    it('should apply RLS policies to tables in JOIN conditions', async () => {
        const sql = `
            SELECT users.name, orders.total 
            FROM users 
            JOIN orders ON users.id = orders.user_id
        `

        const modifiedSql = await applyRLS({
            sql,
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(modifiedSql).toContain('user123')
        expect(modifiedSql).toMatch(/users.*user_id|user_id/)
        expect(modifiedSql).toMatch(/orders.*user_id|user_id/)
    })

    it('should apply RLS policies to multiple tables in a JOIN', async () => {
        const sql = `
            SELECT users.name, orders.total 
            FROM users 
            JOIN orders ON users.id = orders.user_id
        `

        const modifiedSql = await applyRLS({
            sql,
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(modifiedSql).toContain('user123')
        expect(
            (modifiedSql.match(/user123/g) ?? []).length
        ).toBeGreaterThanOrEqual(2)
    })

    it('should apply RLS policies to subqueries inside FROM clause', async () => {
        const sql = `
            SELECT * FROM (
                SELECT * FROM users WHERE age > 18
            ) AS adults
        `

        const modifiedSql = await applyRLS({
            sql,
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(modifiedSql).toContain('user_id')
        expect(modifiedSql).toContain('user123')
        expect(modifiedSql).toContain('age')
    })
})
