import { describe, it, expect } from 'vitest'
import {
    assertPositiveInteger,
    assertValidIdentifier,
    buildCreateTableQuery,
    buildSelectQuery,
    buildUpsertQuery,
    nextCheckpointValue,
    normalizeTables,
    ReplicationConfigurationError,
    rewriteQuerySchemaPrefixes,
} from './utils'

describe('assertValidIdentifier', () => {
    it('should accept valid identifiers', () => {
        expect(assertValidIdentifier('users', 'table name')).toBe('users')
        expect(assertValidIdentifier('_created_at', 'column')).toBe(
            '_created_at'
        )
        expect(assertValidIdentifier('Table1', 'column')).toBe('Table1')
    })

    it('should reject identifiers that could enable SQL injection', () => {
        expect(() =>
            assertValidIdentifier('users; DROP TABLE x', 'table')
        ).toThrowError(ReplicationConfigurationError)
        expect(() => assertValidIdentifier('1users', 'table')).toThrowError()
        expect(() => assertValidIdentifier('user-name', 'table')).toThrowError()
        expect(() => assertValidIdentifier('', 'table')).toThrowError()
        expect(() => assertValidIdentifier(undefined, 'table')).toThrowError()
    })
})

describe('assertPositiveInteger', () => {
    it('should accept positive integers', () => {
        expect(assertPositiveInteger(1, 'batchSize')).toBe(1)
        expect(assertPositiveInteger(1000, 'batchSize')).toBe(1000)
    })

    it('should reject zero, negatives and non-integers', () => {
        expect(() => assertPositiveInteger(0, 'batchSize')).toThrowError()
        expect(() => assertPositiveInteger(-5, 'batchSize')).toThrowError()
        expect(() => assertPositiveInteger(1.5, 'batchSize')).toThrowError()
        expect(() => assertPositiveInteger('10', 'batchSize')).toThrowError()
    })
})

describe('normalizeTables', () => {
    it('should default destinationTable to the source table name', () => {
        const result = normalizeTables([{ name: 'users', trackBy: 'id' }])
        expect(result).toEqual([
            {
                name: 'users',
                trackBy: 'id',
                schema: undefined,
                destinationTable: 'users',
            },
        ])
    })

    it('should preserve schema and custom destinationTable', () => {
        const result = normalizeTables([
            {
                name: 'orders',
                trackBy: 'created_at',
                schema: 'public',
                destinationTable: 'orders_replica',
            },
        ])
        expect(result[0].destinationTable).toBe('orders_replica')
        expect(result[0].schema).toBe('public')
    })

    it('should throw on an empty table list', () => {
        expect(() => normalizeTables([])).toThrowError(
            ReplicationConfigurationError
        )
    })

    it('should throw on duplicate destination tables', () => {
        expect(() =>
            normalizeTables([
                { name: 'users', trackBy: 'id' },
                { name: 'other', trackBy: 'id', destinationTable: 'users' },
            ])
        ).toThrowError(/Duplicate destination table/)
    })

    it('should throw on an invalid trackBy column', () => {
        expect(() =>
            normalizeTables([{ name: 'users', trackBy: 'id; DROP' }])
        ).toThrowError(ReplicationConfigurationError)
    })
})

describe('buildSelectQuery', () => {
    const table = {
        name: 'users',
        trackBy: 'id',
        schema: undefined,
        destinationTable: 'users',
    }

    it('should omit the WHERE clause on the first pull (no checkpoint)', () => {
        const { sql, params } = buildSelectQuery(table, null, 500)
        expect(sql).toBe('SELECT * FROM users ORDER BY id ASC LIMIT 500')
        expect(params).toEqual([])
    })

    it('should add an append-only WHERE clause when a checkpoint exists', () => {
        const { sql, params } = buildSelectQuery(table, 42, 500)
        expect(sql).toBe(
            'SELECT * FROM users WHERE id > ? ORDER BY id ASC LIMIT 500'
        )
        expect(params).toEqual([42])
    })

    it('should qualify the table with its schema when provided', () => {
        const { sql } = buildSelectQuery(
            { ...table, schema: 'public' },
            null,
            10
        )
        expect(sql).toBe('SELECT * FROM public.users ORDER BY id ASC LIMIT 10')
    })

    it('should treat a checkpoint of 0 as a valid value, not "no checkpoint"', () => {
        const { sql, params } = buildSelectQuery(table, 0, 10)
        expect(sql).toContain('WHERE id > ?')
        expect(params).toEqual([0])
    })
})

describe('buildUpsertQuery', () => {
    it('should build an idempotent INSERT OR REPLACE statement', () => {
        const { sql, params } = buildUpsertQuery('users', {
            id: 1,
            name: 'Ada',
        })
        expect(sql).toBe(
            'INSERT OR REPLACE INTO users (id, name) VALUES (?, ?)'
        )
        expect(params).toEqual([1, 'Ada'])
    })

    it('should reject empty rows', () => {
        expect(() => buildUpsertQuery('users', {})).toThrowError(
            ReplicationConfigurationError
        )
    })

    it('should reject malicious column names from the source result set', () => {
        expect(() =>
            buildUpsertQuery('users', { 'id) VALUES (1); DROP': 1 })
        ).toThrowError(ReplicationConfigurationError)
    })
})

describe('nextCheckpointValue', () => {
    it('should return null for an empty batch', () => {
        expect(nextCheckpointValue([], 'id')).toBeNull()
    })

    it('should return the trackBy value of the last (highest) row', () => {
        const rows = [{ id: 1 }, { id: 2 }, { id: 3 }]
        expect(nextCheckpointValue(rows, 'id')).toBe(3)
    })

    it('should support non-numeric tracking columns', () => {
        const rows = [
            { created_at: '2024-01-01' },
            { created_at: '2024-02-01' },
        ]
        expect(nextCheckpointValue(rows, 'created_at')).toBe('2024-02-01')
    })

    it('should throw when the trackBy column is missing from the rows', () => {
        expect(() => nextCheckpointValue([{ name: 'Ada' }], 'id')).toThrowError(
            ReplicationConfigurationError
        )
    })
})

describe('buildCreateTableQuery', () => {
    it('should build a CREATE TABLE statement with trackBy primary key', () => {
        const sql = buildCreateTableQuery('users', ['id', 'name', 'email'], 'id')
        expect(sql).toBe('CREATE TABLE IF NOT EXISTS users (id PRIMARY KEY, name, email)')
    })

    it('should build a CREATE TABLE statement without trackBy if omitted', () => {
        const sql = buildCreateTableQuery('logs', ['timestamp', 'message'])
        expect(sql).toBe('CREATE TABLE IF NOT EXISTS logs (timestamp, message)')
    })

    it('should reject invalid table or column identifiers', () => {
        expect(() => buildCreateTableQuery('users; DROP', ['id'])).toThrowError(
            ReplicationConfigurationError
        )
        expect(() => buildCreateTableQuery('users', ['id; DROP'])).toThrowError(
            ReplicationConfigurationError
        )
    })

    it('should reject empty column lists', () => {
        expect(() => buildCreateTableQuery('users', [])).toThrowError(
            ReplicationConfigurationError
        )
    })
})

describe('rewriteQuerySchemaPrefixes', () => {
    it('should rewrite schema.table to destinationTable', () => {
        const tables = normalizeTables([
            { name: 'users', trackBy: 'id', schema: 'public' },
            { name: 'orders', trackBy: 'id', schema: 'sales', destinationTable: 'replicated_orders' },
        ])

        const sql = 'SELECT * FROM public.users JOIN sales.orders ON public.users.id = sales.orders.user_id'
        const rewritten = rewriteQuerySchemaPrefixes(sql, tables)
        expect(rewritten).toBe('SELECT * FROM users JOIN replicated_orders ON users.id = replicated_orders.user_id')
    })

    it('should not modify queries without matching schema prefixes', () => {
        const tables = normalizeTables([
            { name: 'users', trackBy: 'id', schema: 'public' },
        ])

        const sql = 'SELECT * FROM internal_cache'
        const rewritten = rewriteQuerySchemaPrefixes(sql, tables)
        expect(rewritten).toBe(sql)
    })
})
