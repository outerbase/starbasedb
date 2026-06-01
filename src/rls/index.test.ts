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
        mockConfig.role = 'client'
        vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValue([
            {
                actions: '*',
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

        expect(modifiedSql).toContain(
            "WHERE (`public.users`.`user_id` = 'user123')"
        )
    })
    it('should modify DELETE queries by adding policy-based WHERE clause', async () => {
        const sql = "DELETE FROM users WHERE name = 'Alice'"
        const modifiedSql = await applyRLS({
            sql,
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(modifiedSql).toContain("`name` = 'Alice'")
    })

    it('should modify UPDATE queries with additional WHERE clause', async () => {
        const sql = "UPDATE users SET name = 'Bob' WHERE age = 25"
        const modifiedSql = await applyRLS({
            sql,
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(modifiedSql).toContain("`name` = 'Bob'")
        expect(modifiedSql).toContain('`age` = 25')
    })

    it('should modify INSERT queries to enforce column values', async () => {
        const sql = "INSERT INTO users (user_id, name) VALUES (1, 'Alice')"
        const modifiedSql = await applyRLS({
            sql,
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(modifiedSql).toContain('VALUES (')
    })

    it('should block operations when no matching action policy exists', async () => {
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
        const sql = 'DELETE FROM users WHERE id = 1'
        await expect(
            applyRLS({
                sql,
                isEnabled: true,
                dataSource: mockDataSource,
                config: mockConfig,
            })
        ).rejects.toThrow('Unauthorized access')
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
        vi.resetAllMocks()
        mockDataSource.context.sub = 'user123'
        mockConfig.role = 'client'
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

        expect(modifiedSql).toContain("`user_id` = 'user123'")
    })

    it('should apply RLS WHERE clause to the first matching table in a JOIN', async () => {
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

        expect(modifiedSql).toContain('WHERE')
        expect(modifiedSql).toContain("'user123'")
    })

    it('should preserve original SQL structure for subqueries in FROM clause', async () => {
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

        expect(modifiedSql).toContain('WHERE')
        expect(modifiedSql).toContain('age')
    })
})
