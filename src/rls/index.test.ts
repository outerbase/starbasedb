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

describe('applyRLS - Query Modification', () => {
    beforeEach(() => {
        vi.resetAllMocks()
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
        ])
    })

    it('should modify SELECT queries with WHERE conditions', async () => {
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
        vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValue([
            {
                actions: 'DELETE',
                schema: '',
                table: 'users',
                column: 'user_id',
                value: 'context.id()',
                value_type: 'string',
                operator: '=',
            },
        ])
        const sql = "DELETE FROM users WHERE name = 'Alice'"
        const modifiedSql = await applyRLS({
            sql,
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(modifiedSql).toContain("`name` = 'Alice'")
        expect(modifiedSql).toContain("`users`.`user_id` = 'user123'")
    })

    it('should modify UPDATE queries with additional WHERE clause', async () => {
        vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValue([
            {
                actions: 'UPDATE',
                schema: '',
                table: 'users',
                column: 'user_id',
                value: 'context.id()',
                value_type: 'string',
                operator: '=',
            },
        ])
        const sql = "UPDATE users SET name = 'Bob' WHERE age = 25"
        const modifiedSql = await applyRLS({
            sql,
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(modifiedSql).toContain("`name` = 'Bob'")
        expect(modifiedSql).toContain('`age` = 25')
        expect(modifiedSql).toContain("`users`.`user_id` = 'user123'")
    })

    it('should modify INSERT queries to enforce column values', async () => {
        vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValue([
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
        const sql = "INSERT INTO users (user_id, name) VALUES (1, 'Alice')"
        const modifiedSql = await applyRLS({
            sql,
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(modifiedSql).toContain("VALUES ('user123','Alice')")
    })

    it('should throw when action is not allowed on a restricted table', async () => {
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
        await expect(
            applyRLS({
                sql: "DELETE FROM users WHERE name = 'Alice'",
                isEnabled: true,
                dataSource: mockDataSource,
                config: mockConfig,
            })
        ).rejects.toThrow(
            'Unauthorized access: No matching rules for DELETE on restricted table users'
        )
    })

    it('should throw when SQL is empty and RLS is enabled', async () => {
        await expect(
            applyRLS({
                sql: '',
                isEnabled: true,
                dataSource: mockDataSource,
                config: mockConfig,
            })
        ).rejects.toThrow('No SQL query found in RLS plugin.')
    })

    it('should support numeric value_type and CTE / UNION / subquery / multi-statement queries', async () => {
        vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValue([
            {
                actions: 'SELECT',
                schema: '',
                table: 'users',
                column: 'tenant_id',
                value: '42',
                value_type: 'number',
                operator: '=',
            },
        ])

        const cteSql =
            'WITH active_users AS (SELECT * FROM users) SELECT * FROM active_users'
        const modifiedCte = await applyRLS({
            sql: cteSql,
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })
        expect(modifiedCte).toContain('`users`.`tenant_id` =')

        const unionSql =
            'SELECT id FROM users UNION SELECT id FROM users WHERE id > 1'
        const modifiedUnion = await applyRLS({
            sql: unionSql,
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })
        expect(modifiedUnion).toContain('UNION')
        expect(modifiedUnion).toContain('`users`.`tenant_id` =')

        const multiSql = 'SELECT * FROM users; SELECT * FROM users WHERE id = 2'
        const modifiedMulti = await applyRLS({
            sql: multiSql,
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })
        expect(modifiedMulti).toContain(';')
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

    it('should not modify SQL if user is admin', async () => {
        const adminConfig: StarbaseDBConfiguration = {
            ...mockConfig,
            role: 'admin',
        }

        const sql = 'SELECT * FROM users'
        const modifiedSql = await applyRLS({
            sql,
            isEnabled: true,
            dataSource: mockDataSource,
            config: adminConfig,
        })

        expect(modifiedSql).toBe(sql)
    })

    it('should return empty policies when executeQuery returns empty array', async () => {
        const consoleErrorSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})
        vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValue([])
        const res = await loadPolicies(mockDataSource)
        expect(res).toEqual([])
        consoleErrorSpy.mockRestore()
    })

    it('should throw when SQL cannot be parsed', async () => {
        const consoleErrorSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})
        vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValue([])
        await expect(
            applyRLS({
                sql: 'SELECT FROM WHERE ???',
                isEnabled: true,
                dataSource: mockDataSource,
                config: mockConfig,
            })
        ).rejects.toThrow()
        consoleErrorSpy.mockRestore()
    })
})

describe('applyRLS - Multi-Table Queries', () => {
    beforeEach(() => {
        mockConfig.role = 'client'
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

        expect(modifiedSql).toContain("`users`.`user_id` = 'user123'")
        expect(modifiedSql).toContain("`orders`.`user_id` = 'user123'")
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

        expect(modifiedSql).toContain("(`users`.`user_id` = 'user123')")
        expect(modifiedSql).toContain("(`orders`.`user_id` = 'user123')")
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

        expect(modifiedSql).toContain("`users`.`user_id` = 'user123'")
    })
})
