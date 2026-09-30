import { describe, it, expect, vi, beforeEach } from 'vitest'
import { applyRLS, loadPolicies } from './index'
import { DataSource, QueryResult } from '../types'
import { StarbaseDBConfiguration } from '../handler'
import { createClient } from '@libsql/client'
import { Parser } from 'node-sql-parser'

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

function policyFor(action: string, table = 'users') {
    return {
        actions: action,
        schema: 'public',
        table,
        column: 'user_id',
        value: 'context.id()',
        value_type: 'string',
        operator: '=',
    }
}

beforeEach(() => {
    vi.restoreAllMocks()
    vi.resetAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mockConfig.role = 'client'
    mockDataSource.context.sub = 'user123'
    vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValue([
        policyFor('SELECT'),
    ])
})

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

        expect(modifiedSql).toContain("`users`.`user_id` = 'user123'")
    })
    it('should modify DELETE queries by adding policy-based WHERE clause', async () => {
        vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValue([
            policyFor('DELETE'),
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
            policyFor('UPDATE'),
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
            policyFor('INSERT'),
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

    it.each([
        'DELETE FROM users',
        "UPDATE users SET name = 'Bob'",
        "INSERT INTO users (user_id) VALUES ('other')",
    ])(
        'rejects an action absent from the restricted table policy: %s',
        async (sql) => {
            await expect(
                applyRLS({
                    sql,
                    isEnabled: true,
                    dataSource: mockDataSource,
                    config: mockConfig,
                })
            ).rejects.toThrow('No matching rules')
        }
    )

    it('uses wildcard policy permission for INSERT and enforces its value', async () => {
        vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValue([
            policyFor('*'),
        ])
        const sql = await applyRLS({
            sql: "INSERT INTO users (user_id, name) VALUES ('other', 'Alice')",
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })
        expect(sql).toContain("VALUES ('user123','Alice')")
    })

    it('keeps explicitly different schemas separate', async () => {
        const sql = await applyRLS({
            sql: 'SELECT * FROM private.users',
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })
        expect(sql).not.toContain('user_id')
    })

    it('applies a schema-qualified policy to a matching schema and table alias', async () => {
        const sql = await applyRLS({
            sql: 'SELECT u.name FROM public.users AS u',
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })
        expect(sql).toContain("`u`.`user_id` = 'user123'")
        expect(sql).not.toContain('`public.users`')
    })

    it.each(['public', undefined])(
        'does not combine %s SELECT permission with a private-schema DELETE policy',
        async (schema) => {
            vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValue([
                { ...policyFor('SELECT'), schema },
                { ...policyFor('DELETE'), schema: 'private' },
            ])
            await expect(
                applyRLS({
                    sql: 'DELETE FROM users',
                    isEnabled: true,
                    dataSource: mockDataSource,
                    config: mockConfig,
                })
            ).rejects.toThrow('Ambiguous RLS schema')
        }
    )

    it('uses the configured default schema without borrowing other schema permissions', async () => {
        vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValue([
            policyFor('SELECT'),
            { ...policyFor('DELETE'), schema: 'private' },
        ])
        const dataSource = {
            ...mockDataSource,
            source: 'external',
            external: { dialect: 'sqlite', defaultSchema: 'public' },
        } as DataSource
        await expect(
            applyRLS({
                sql: 'DELETE FROM users',
                isEnabled: true,
                dataSource,
                config: mockConfig,
            })
        ).rejects.toThrow('No matching rules for DELETE')
        const sql = await applyRLS({
            sql: 'SELECT * FROM users',
            isEnabled: true,
            dataSource,
            config: mockConfig,
        })
        expect(sql.match(/user_id/g)).toHaveLength(1)
    })

    it.each([
        'INSERT INTO users (user_id, name) SELECT user_id, name FROM accounts',
        "INSERT INTO users (name) VALUES ('Alice')",
        "INSERT INTO users VALUES ('Alice')",
    ])(
        'rejects a protected INSERT when its policy value cannot be enforced: %s',
        async (sql) => {
            vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValue([
                policyFor('INSERT'),
            ])
            await expect(
                applyRLS({
                    sql,
                    isEnabled: true,
                    dataSource: mockDataSource,
                    config: mockConfig,
                })
            ).rejects.toThrow('RLS INSERT requires')
        }
    )
})

describe('applyRLS - Edge Cases', () => {
    it('rejects enabled non-admin queries when no policies are returned', async () => {
        vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValue([])
        await expect(
            applyRLS({
                sql: 'SELECT * FROM users',
                isEnabled: true,
                dataSource: mockDataSource,
                config: mockConfig,
            })
        ).rejects.toThrow('RLS policies are unavailable or empty')
    })

    it('rejects enabled non-admin queries when policy loading fails', async () => {
        vi.mocked(mockDataSource.rpc.executeQuery).mockRejectedValue(
            new Error('policy store unavailable')
        )
        await expect(
            applyRLS({
                sql: 'SELECT * FROM users',
                isEnabled: true,
                dataSource: mockDataSource,
                config: mockConfig,
            })
        ).rejects.toThrow('RLS policies are unavailable or empty')
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
        expect(mockDataSource.rpc.executeQuery).not.toHaveBeenCalled()
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
        expect(mockDataSource.rpc.executeQuery).not.toHaveBeenCalled()
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

        expect(modifiedSql).toContain("`users`.`user_id` = 'user123'")
        expect(modifiedSql).toContain("`orders`.`user_id` = 'user123'")
    })

    it('should apply RLS policies to aliases in a JOIN', async () => {
        const sql = `
            SELECT u.name, o.total
            FROM users AS u
            JOIN orders AS o ON u.id = o.user_id
        `

        const modifiedSql = await applyRLS({
            sql,
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(modifiedSql).toContain("`u`.`user_id` = 'user123'")
        expect(modifiedSql).toContain("`o`.`user_id` = 'user123'")
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

    it('enforces every occurrence of a protected table in a self join', async () => {
        const sql = await applyRLS({
            sql: 'SELECT a.name, b.name FROM users AS a JOIN users AS b ON a.id = b.id',
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })
        expect(sql).toContain("`a`.`user_id` = 'user123'")
        expect(sql).toContain("`b`.`user_id` = 'user123'")
    })
})

describe('applyRLS - Executable SQLite regressions', () => {
    it.each([
        "SELECT name FROM users WHERE name = 'Alice' OR 1 = 1",
        'SELECT name FROM (SELECT name FROM users) AS names',
        'SELECT a.name FROM users AS a JOIN users AS b ON a.id = b.id',
        'WITH visible AS (SELECT name FROM users) SELECT name FROM visible',
        "SELECT name FROM users WHERE name = 'Alice' UNION SELECT name FROM users",
        "SELECT COALESCE((SELECT name FROM users ORDER BY id LIMIT 1),'') AS name",
        'SELECT name FROM USERS',
    ])('returns only authorized rows for %s', async (sql) => {
        const db = createClient({ url: ':memory:' })
        try {
            await db.execute(
                'CREATE TABLE users (id INTEGER, name TEXT, user_id TEXT)'
            )
            await db.execute(
                "INSERT INTO users VALUES (1, 'Mallory', 'other'), (2, 'Alice', 'user123')"
            )
            const restricted = await applyRLS({
                sql,
                isEnabled: true,
                dataSource: mockDataSource,
                config: mockConfig,
            })
            const result = await db.execute(restricted)
            expect(result.rows.map((row) => row.name)).toEqual(['Alice'])
        } finally {
            db.close()
        }
    })

    it('INSERT SELECT copies only authorized source rows into an unrestricted target', async () => {
        const db = createClient({ url: ':memory:' })
        try {
            await db.execute('CREATE TABLE users (name TEXT, user_id TEXT)')
            await db.execute('CREATE TABLE accounts (name TEXT)')
            await db.execute(
                "INSERT INTO users VALUES ('Mallory', 'other'), ('Alice', 'user123')"
            )
            const sql = await applyRLS({
                sql: 'INSERT INTO accounts (name) SELECT name FROM users',
                isEnabled: true,
                dataSource: mockDataSource,
                config: mockConfig,
            })
            await db.execute(sql)
            const result = await db.execute('SELECT name FROM accounts')
            expect(result.rows.map((row) => row.name)).toEqual(['Alice'])
        } finally {
            db.close()
        }
    })

    it("UPDATE and DELETE cannot change another user's rows", async () => {
        vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValue([
            policyFor('UPDATE'),
            policyFor('DELETE'),
        ])
        const db = createClient({ url: ':memory:' })
        try {
            await db.execute(
                'CREATE TABLE users (id INTEGER, name TEXT, user_id TEXT)'
            )
            await db.execute(
                "INSERT INTO users VALUES (1, 'Alice', 'user123'), (2, 'Mallory', 'other')"
            )
            for (const sql of [
                "UPDATE users SET name = 'Changed' WHERE 1 = 1",
                'DELETE FROM users WHERE 1 = 1',
            ]) {
                await db.execute(
                    await applyRLS({
                        sql,
                        isEnabled: true,
                        dataSource: mockDataSource,
                        config: mockConfig,
                    })
                )
            }
            const result = await db.execute('SELECT name, user_id FROM users')
            expect(
                result.rows.map((row) => ({
                    name: row.name,
                    user_id: row.user_id,
                }))
            ).toEqual([{ name: 'Mallory', user_id: 'other' }])
        } finally {
            db.close()
        }
    })
})

describe('applyRLS - Other dialect AST regressions', () => {
    it.each(['mysql', 'postgresql'])(
        'filters nested SELECTs in %s UPDATE assignments and JOIN predicates',
        async (dialect) => {
            const dataSource = {
                ...mockDataSource,
                source: 'external',
                external: { dialect, defaultSchema: 'public' },
            } as DataSource
            const parser = new Parser()
            const update = await applyRLS({
                sql: 'UPDATE accounts SET name = (SELECT name FROM users LIMIT 1)',
                isEnabled: true,
                dataSource,
                config: mockConfig,
            })
            const updateAst = parser.astify(update, {
                database: dialect,
            }) as any
            expect(updateAst.set[0].value.ast.where.left).toMatchObject({
                type: 'column_ref',
                table: 'users',
                column: 'user_id',
            })
            expect(updateAst.set[0].value.ast.where.right.value).toBe('user123')

            const join = await applyRLS({
                sql: 'SELECT accounts.name FROM accounts JOIN teams ON teams.id = (SELECT id FROM users ORDER BY id LIMIT 1)',
                isEnabled: true,
                dataSource,
                config: mockConfig,
            })
            const joinAst = parser.astify(join, { database: dialect }) as any
            expect(joinAst.from[1].on.right.ast.where.left).toMatchObject({
                type: 'column_ref',
                table: 'users',
                column: 'user_id',
            })
            expect(joinAst.from[1].on.right.ast.where.right.value).toBe(
                'user123'
            )
        }
    )
})
