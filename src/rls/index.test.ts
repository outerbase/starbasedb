import { describe, it, expect, vi, beforeEach } from 'vitest'
import { applyRLS, loadPolicies } from './index'
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
    beforeEach(() => {
        vi.resetAllMocks()
    })

    it('should load and parse policies correctly including number value_type and quoted identifiers', async () => {
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
                actions: 'UPDATE',
                schema: '',
                table: '"orders"',
                column: '`amount`',
                value: '100',
                value_type: 'number',
                operator: '>',
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
            {
                action: 'UPDATE',
                condition: {
                    type: 'binary_expr',
                    operator: '>',
                    left: {
                        type: 'column_ref',
                        table: 'orders',
                        column: 'amount',
                    },
                    right: {
                        type: 'string',
                        value: 100,
                    },
                },
            },
        ])
    })

    it('should return an empty array if no policies exist or an error occurs', async () => {
        const consoleErrorSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})

        vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValueOnce(
            [] as any
        )
        expect(await loadPolicies(mockDataSource)).toEqual([])

        vi.mocked(mockDataSource.rpc.executeQuery).mockRejectedValueOnce(
            new Error('Database error')
        )
        expect(await loadPolicies(mockDataSource)).toEqual([])

        consoleErrorSpy.mockRestore()
    })
})

describe('applyRLS - Query Modification', () => {
    beforeEach(() => {
        vi.resetAllMocks()
        mockConfig.role = 'client'
        mockDataSource.context = { sub: 'user123' }
        vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValue([
            {
                actions: 'SELECT',
                schema: '',
                table: 'users',
                column: 'user_id',
                value: 'context.id()',
                value_type: 'string',
                operator: '=',
            },
            {
                actions: 'DELETE',
                schema: '',
                table: 'users',
                column: 'user_id',
                value: 'context.id()',
                value_type: 'string',
                operator: '=',
            },
            {
                actions: 'UPDATE',
                schema: '',
                table: 'users',
                column: 'user_id',
                value: 'context.id()',
                value_type: 'string',
                operator: '=',
            },
            {
                actions: 'INSERT',
                schema: '',
                table: 'users',
                column: 'user_id',
                value: 'context.id()',
                value_type: 'string',
                operator: '=',
            },
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

        expect(modifiedSql).toContain("WHERE (`users`.`user_id` = 'user123')")
    })

    it('should modify DELETE queries by adding policy-based WHERE clause', async () => {
        const sql = "DELETE FROM users WHERE name = 'Alice'"
        const modifiedSql = await applyRLS({
            sql,
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(modifiedSql).toContain(
            "WHERE ((`name` = 'Alice') AND (`users`.`user_id` = 'user123'))"
        )
    })

    it('should modify UPDATE queries with additional WHERE clause', async () => {
        const sql = "UPDATE public.users SET name = 'Bob' WHERE age = 25"
        const modifiedSql = await applyRLS({
            sql,
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(modifiedSql).toContain(
            "SET `name` = 'Bob' WHERE ((`age` = 25) AND (`users`.`user_id` = 'user123'))"
        )
    })

    it('should modify INSERT queries to enforce column values', async () => {
        const sql =
            "INSERT INTO public.users (user_id, name) VALUES (1, 'Alice')"
        const modifiedSql = await applyRLS({
            sql,
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(modifiedSql).toContain("VALUES ('user123','Alice')")
    })

    it('should throw Unauthorized access when table has rules but action is not permitted', async () => {
        const consoleErrorSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})
        vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValueOnce([
            {
                actions: 'SELECT',
                schema: '',
                table: 'users',
                column: 'user_id',
                value: 'context.id()',
                value_type: 'string',
                operator: '=',
            },
        ])

        await expect(
            applyRLS({
                sql: 'DELETE FROM public.users WHERE id = 1',
                isEnabled: true,
                dataSource: mockDataSource,
                config: mockConfig,
            })
        ).rejects.toThrow(
            'Unauthorized access: No matching rules for DELETE on restricted table users'
        )
        consoleErrorSpy.mockRestore()
    })
})

describe('applyRLS - Edge Cases', () => {
    beforeEach(() => {
        mockConfig.role = 'client'
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

    it('should throw an error if SQL string is empty', async () => {
        await expect(
            applyRLS({
                sql: '',
                isEnabled: true,
                dataSource: mockDataSource,
                config: mockConfig,
            })
        ).rejects.toThrow('No SQL query found in RLS plugin.')
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

    it('should handle multiple statements, CTEs, and UNIONs', async () => {
        vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValue([
            {
                actions: 'SELECT',
                schema: '',
                table: 'users',
                column: 'user_id',
                value: 'context.id()',
                value_type: 'string',
                operator: '=',
            },
        ])

        const multiSql =
            'WITH cte AS (SELECT * FROM users) SELECT * FROM users UNION SELECT * FROM users; SELECT * FROM users'
        const modified = await applyRLS({
            sql: multiSql,
            isEnabled: true,
            dataSource: {
                ...mockDataSource,
                source: 'external',
                external: { dialect: 'postgresql' },
            },
            config: mockConfig,
        })

        expect(modified).toContain("'user123'")
    })
})

describe('applyRLS - Multi-Table Queries', () => {
    beforeEach(() => {
        mockConfig.role = 'client'
        mockDataSource.context = { sub: 'user123' }
        vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValue([
            {
                actions: 'SELECT',
                schema: '',
                table: 'users',
                column: 'user_id',
                value: 'context.id()',
                value_type: 'string',
                operator: '=',
            },
            {
                actions: 'SELECT',
                schema: '',
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

        expect(modifiedSql).toContain("WHERE ((`users`.`user_id` = 'user123')")
        expect(modifiedSql).toContain("AND (`orders`.`user_id` = 'user123'))")
    })
})
