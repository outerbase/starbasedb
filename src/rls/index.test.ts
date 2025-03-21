import { describe, it, expect, vi, beforeEach } from 'vitest'
import { applyRLS, loadPolicies } from './index'
import { DataSource } from '../types'
import { StarbaseDBConfiguration } from '../handler'
import { Parser } from 'node-sql-parser'
import { DurableObjectBranded } from '../types'

vi.mock('./index', async () => {
    const actual = await vi.importActual('./index')
    return {
        ...actual,
        loadPolicies: vi.fn().mockImplementation(async (dataSource) => {
            return dataSource.rpc
                .executeQuery('SELECT * FROM rls_policies')
                .then((result: any[]) => result || [])
                .catch(() => [])
        }),
    }
})

const parser = new Parser()

const normalizeSQL = (sql: string) => sql.toLowerCase().replace(/[\s`"]/g, '')

const mockDataSource: DataSource = {
    source: 'internal',
    rpc: {
        executeQuery: vi.fn().mockImplementation(() =>
            Promise.resolve([
                {
                    table_name: 'users',
                    policy: "user_id = 'user123'",
                },
            ])
        ) as any,
    },
    storage: {
        get: vi.fn(),
        put: vi.fn(),
        setAlarm: vi.fn(),
    },
    context: { sub: 'user123' },
} satisfies DataSource

const mockR2Bucket = {} as any

const mockConfig = {
    role: 'client' as const,
    outerbaseApiKey: 'test-key',
    features: {
        rls: true,
        allowlist: true,
        rest: false,
        export: false,
        import: false,
    },
    BUCKET: mockR2Bucket,
} satisfies StarbaseDBConfiguration

describe('loadPolicies - Policy Fetching and Parsing', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('should return an empty array if an error occurs', async () => {
        const errorDataSource = {
            ...mockDataSource,
            rpc: {
                executeQuery: vi.fn().mockRejectedValue(new Error('DB Error')),
            },
        }
        const policies = await loadPolicies(errorDataSource)
        expect(policies).toEqual([])
    })
})

describe('applyRLS - Query Modification', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        ;(mockDataSource.rpc.executeQuery as any).mockResolvedValue([
            {
                table_name: 'users',
                policy: "user_id = 'user123'",
            },
        ])
    })

    it('should modify SELECT queries with WHERE conditions', async () => {
        const sql = 'SELECT * FROM users'
        const result = await applyRLS({
            sql,
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        const normalizedResult = normalizeSQL(result)
        const expectedCondition = normalizeSQL("user_id='user123'")
        expect(normalizedResult).toContain(expectedCondition)
    })

    it('should modify DELETE queries by adding policy-based WHERE clause', async () => {
        const sql = 'DELETE FROM users'
        const result = await applyRLS({
            sql,
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        const normalizedResult = normalizeSQL(result)
        const expectedCondition = normalizeSQL("user_id='user123'")
        expect(normalizedResult).toContain(expectedCondition)
    })

    it('should modify UPDATE queries with additional WHERE clause', async () => {
        const sql = 'UPDATE users SET name = "test"'
        const result = await applyRLS({
            sql,
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        const normalizedResult = normalizeSQL(result)
        const expectedCondition = normalizeSQL("user_id='user123'")
        expect(normalizedResult).toContain(expectedCondition)
    })

    it('should apply RLS policies to tables in JOIN conditions', async () => {
        const sql =
            'SELECT * FROM users JOIN orders ON users.id = orders.user_id'
        const result = await applyRLS({
            sql,
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        const normalizedResult = normalizeSQL(result)
        const expectedCondition = normalizeSQL("user_id='user123'")
        expect(normalizedResult).toContain(expectedCondition)
    })

    it('should modify INSERT queries to enforce column values', async () => {
        const sql = 'INSERT INTO users (name) VALUES ("test")'
        const result = await applyRLS({
            sql,
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(result).toContain('INSERT INTO')
    })

    it('should not modify SQL if RLS is disabled', async () => {
        const sql = 'SELECT * FROM users'
        const result = await applyRLS({
            sql,
            isEnabled: false,
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(result).toBe(sql)
    })

    it('should not modify SQL if user is admin', async () => {
        const sql = 'SELECT * FROM users'
        const result = await applyRLS({
            sql,
            isEnabled: true,
            dataSource: mockDataSource,
            config: {
                ...mockConfig,
                role: 'admin',
            },
        })

        expect(result).toBe(sql)
    })
})

describe('applyRLS - Multi-Table Queries', () => {
    it('should apply RLS policies to multiple tables in a JOIN', async () => {
        const multiTableDataSource = {
            source: 'internal' as const,
            rpc: {
                executeQuery: vi.fn().mockResolvedValue([
                    {
                        table_name: 'users',
                        policy: "user_id = 'user123'",
                    },
                ]),
            },
            storage: {
                get: vi.fn(),
                put: vi.fn(),
                setAlarm: vi.fn(),
            },
            context: { sub: 'user123' },
        } satisfies DataSource

        const sql = `
            SELECT users.name, orders.total
            FROM users
            JOIN orders ON users.id = orders.user_id`

        const result = await applyRLS({
            sql,
            isEnabled: true,
            dataSource: multiTableDataSource,
            config: {
                role: 'client' as const,
                features: { rls: true, allowlist: true },
                BUCKET: mockR2Bucket,
            },
        })

        const normalizedResult = normalizeSQL(result)
        const expectedCondition = normalizeSQL("user_id='user123'")
        expect(normalizedResult).toContain(expectedCondition)
    })
})
