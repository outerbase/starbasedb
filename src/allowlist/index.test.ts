import { describe, it, expect, vi, beforeEach } from 'vitest'
import { isQueryAllowed } from './index'
import type { DataSource } from '../types'
import type { StarbaseDBConfiguration } from '../handler'

// Mock the node-sql-parser module used inside allowlist/index.ts
vi.mock('node-sql-parser', () => {
    const Parser = vi.fn().mockImplementation(() => ({
        astify: vi.fn((sql: string) => {
            // Return a simple deterministic AST keyed by the normalized SQL
            return { type: 'select', table: sql, columns: [] }
        }),
    }))
    return { Parser }
})

function makeMockDataSource(rows: Record<string, unknown>[] = []): DataSource {
    return {
        source: 'internal',
        rpc: {
            executeQuery: vi.fn().mockResolvedValue(rows),
        },
    } as unknown as DataSource
}

function makeConfig(role: 'admin' | 'client' = 'client'): StarbaseDBConfiguration {
    return {
        outerbaseApiKey: 'test-key',
        role,
        features: { allowlist: true, rls: false, rest: false },
    } as StarbaseDBConfiguration
}

describe('isQueryAllowed', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('returns true when allowlist feature is disabled', async () => {
        const dataSource = makeMockDataSource()
        const config = makeConfig()
        const result = await isQueryAllowed({
            sql: 'SELECT * FROM users',
            isEnabled: false,
            dataSource,
            config,
        })
        expect(result).toBe(true)
        // dataSource should not be queried when feature is off
        expect(dataSource.rpc.executeQuery).not.toHaveBeenCalled()
    })

    it('returns true for admin role even when allowlist is enabled', async () => {
        const dataSource = makeMockDataSource([])
        const config = makeConfig('admin')
        const result = await isQueryAllowed({
            sql: 'SELECT * FROM secrets',
            isEnabled: true,
            dataSource,
            config,
        })
        expect(result).toBe(true)
        // Admin bypass must not hit the allowlist DB
        expect(dataSource.rpc.executeQuery).not.toHaveBeenCalled()
    })

    it('throws when no SQL is provided', async () => {
        const dataSource = makeMockDataSource([])
        const config = makeConfig()
        await expect(
            isQueryAllowed({
                sql: '',
                isEnabled: true,
                dataSource,
                config,
            })
        ).rejects.toThrow('No SQL provided for allowlist check')
    })

    it('throws for a query that is not in the allowlist', async () => {
        // allowlist returns a row whose sql_statement parses to a *different* AST
        const dataSource = makeMockDataSource([
            { sql_statement: 'SELECT id FROM users', source: 'internal' },
        ])
        const config = makeConfig()
        await expect(
            isQueryAllowed({
                sql: 'DROP TABLE users',
                isEnabled: true,
                dataSource,
                config,
            })
        ).rejects.toThrow()
    })

    it('returns true when the query matches an allowlist entry', async () => {
        const sql = 'SELECT id FROM users'
        // The mock parser returns { type: 'select', table: sql, columns: [] }
        // so both the allowlist row and the query will produce identical ASTs
        const dataSource = makeMockDataSource([
            { sql_statement: sql, source: 'internal' },
        ])
        const config = makeConfig()
        const result = await isQueryAllowed({
            sql,
            isEnabled: true,
            dataSource,
            config,
        })
        expect(result).toBe(true)
    })

    it('filters allowlist rows by matching source field', async () => {
        // Row from a different source should be excluded; effective allowlist = empty
        const dataSource = {
            source: 'internal',
            rpc: {
                executeQuery: vi.fn().mockResolvedValue([
                    { sql_statement: 'SELECT id FROM users', source: 'external' },
                ]),
            },
        } as unknown as DataSource
        const config = makeConfig()
        await expect(
            isQueryAllowed({
                sql: 'SELECT id FROM users',
                isEnabled: true,
                dataSource,
                config,
            })
        ).rejects.toThrow()
    })

    it('handles loadAllowlist DB errors gracefully (falls back to empty list)', async () => {
        const dataSource = {
            source: 'internal',
            rpc: {
                executeQuery: vi.fn().mockRejectedValue(new Error('DB down')),
            },
        } as unknown as DataSource
        const config = makeConfig()
        // Empty allowlist → query is not allowed → should throw
        await expect(
            isQueryAllowed({
                sql: 'SELECT 1',
                isEnabled: true,
                dataSource,
                config,
            })
        ).rejects.toThrow()
    })

    it('normalizeSQL strips trailing semicolons before AST comparison', async () => {
        const sqlWithSemicolon = 'SELECT id FROM users;'
        const sqlWithoutSemicolon = 'SELECT id FROM users'
        // Both are normalized to the same string by the time astify is called,
        // so the parser receives the same input and returns equal ASTs.
        const dataSource = makeMockDataSource([
            { sql_statement: sqlWithoutSemicolon, source: 'internal' },
        ])
        const config = makeConfig()
        // Should resolve to true because normalization makes them equal
        const result = await isQueryAllowed({
            sql: sqlWithSemicolon,
            isEnabled: true,
            dataSource,
            config,
        })
        expect(result).toBe(true)
    })
})
