import { describe, expect, it } from 'vitest'
import {
    assertSqliteIdent,
    buildBatchUpsert,
    mapValueForSqlite,
} from './sync-engine'
import type { TableSyncJob } from './types'

describe('mapValueForSqlite', () => {
    it('serializes bigint and Date', () => {
        expect(mapValueForSqlite(1n)).toBe('1')
        const d = new Date('2024-01-02T03:04:05.000Z')
        expect(mapValueForSqlite(d)).toBe('2024-01-02T03:04:05.000Z')
    })

    it('JSON-encodes plain objects', () => {
        expect(mapValueForSqlite({ a: 1 })).toBe('{"a":1}')
    })
})

describe('assertSqliteIdent', () => {
    it('accepts valid identifiers', () => {
        expect(() => assertSqliteIdent('users', 't')).not.toThrow()
        expect(() => assertSqliteIdent('_x1', 't')).not.toThrow()
    })

    it('rejects invalid identifiers', () => {
        expect(() => assertSqliteIdent('bad-name', 't')).toThrow()
        expect(() => assertSqliteIdent("'; DROP--", 't')).toThrow()
    })
})

describe('buildBatchUpsert', () => {
    const job: TableSyncJob = {
        externalTable: 'public.users',
        localTable: 'users',
        cursorKind: 'incremental_id',
        cursorColumn: 'id',
        pkColumns: ['id'],
    }

    it('builds INSERT ... ON CONFLICT for one row', () => {
        const q = buildBatchUpsert(job, [{ id: 1, name: 'a' }])
        expect(q).not.toBeNull()
        expect(q!.sql).toContain('INSERT INTO "users"')
        expect(q!.sql).toContain('ON CONFLICT("id")')
        expect(q!.params).toEqual([1, 'a'])
    })

    it('builds multi-row batch', () => {
        const q = buildBatchUpsert(job, [
            { id: 1, name: 'a' },
            { id: 2, name: 'b' },
        ])
        expect(q!.params).toEqual([1, 'a', 2, 'b'])
    })
})
