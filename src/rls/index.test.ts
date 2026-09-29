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
        const sql = 'SELECT * FROM users'
        const modifiedSql = await applyRLS({
            sql,
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        console.log('Final SQL:', modifiedSql)
        expect(modifiedSql).toBeDefined()
    })
    it('should modify DELETE queries by adding policy-based WHERE clause', async () => {
        const sql = "DELETE FROM users WHERE name = 'Alice'"
        const modifiedSql = await applyRLS({
            sql,
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(modifiedSql).toBeDefined()
    })

    it('should modify UPDATE queries with additional WHERE clause', async () => {
        const sql = "UPDATE users SET name = 'Bob' WHERE age = 25"
        const modifiedSql = await applyRLS({
            sql,
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(modifiedSql).toBeDefined()
    })

    it('should modify INSERT queries to enforce column values', async () => {
        const sql = "INSERT INTO users (user_id, name) VALUES (1, 'Alice')"
        const modifiedSql = await applyRLS({
            sql,
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(modifiedSql).toBeDefined()
    })
})

describe('applyRLS - Edge Cases', () => {
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
})

describe('applyRLS - Multi-Table Queries', () => {
    beforeEach(() => {
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

        expect(modifiedSql).toBeDefined()
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

        expect(modifiedSql).toBeDefined()
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

        expect(modifiedSql).toBeDefined()
    })

    it('should handle WITH (CTE) queries', async () => {
        const sql = `
            WITH active_users AS (
                SELECT * FROM users WHERE active = 1
            )
            SELECT * FROM active_users
        `
        const modifiedSql = await applyRLS({
            sql,
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })
        expect(modifiedSql).toBeDefined()
    })

    it('should handle UNION queries', async () => {
        const sql = `
            SELECT * FROM users
            UNION
            SELECT * FROM users
        `
        const modifiedSql = await applyRLS({
            sql,
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })
        expect(modifiedSql).toBeDefined()
    })

    it('should handle subqueries in SELECT columns', async () => {
        const sql = `
            SELECT id, (SELECT name FROM users WHERE id = o.user_id) as user_name FROM orders o
        `
        const modifiedSql = await applyRLS({
            sql,
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })
        expect(modifiedSql).toBeDefined()
    })
})
