import { describe, it, expect, vi, beforeEach } from 'vitest'
import { dumpDatabaseRoute } from './dump'
import { executeOperation } from '.'
import type { DataSource } from '../types'
import type { StarbaseDBConfiguration } from '../handler'

vi.mock('.', () => ({
    executeOperation: vi.fn(),
}))

vi.mock('../utils', () => ({
    createResponse: vi.fn(
        (data, message, status) =>
            new Response(JSON.stringify({ result: data, error: message }), {
                status,
                headers: { 'Content-Type': 'application/json' },
            })
    ),
}))

// Internal alias dump.ts attaches to keyset-paginated rows. Mock row pages
// include it so the cursor logic is exercised the same way as in production.
const ROWID = '__starbasedb_export_rowid__'

let mockDataSource: DataSource
let mockConfig: StarbaseDBConfiguration

beforeEach(() => {
    vi.clearAllMocks()

    mockDataSource = {
        source: 'internal',
        rpc: { executeQuery: vi.fn() },
    } as any

    mockConfig = {
        outerbaseApiKey: 'mock-api-key',
        role: 'admin',
        features: { allowlist: true, rls: true, rest: true },
    }
})

describe('Database Dump Module', () => {
    it('streams a dump with header, schema and quoted INSERTs', async () => {
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'users' }, { name: 'orders' }])
            .mockResolvedValueOnce([
                { sql: 'CREATE TABLE users (id INTEGER, name TEXT)' },
            ])
            .mockResolvedValueOnce([
                { id: 1, name: 'Alice', [ROWID]: 1 },
                { id: 2, name: 'Bob', [ROWID]: 2 },
            ])
            .mockResolvedValueOnce([
                { sql: 'CREATE TABLE orders (id INTEGER, total REAL)' },
            ])
            .mockResolvedValueOnce([
                { id: 1, total: 99.99, [ROWID]: 1 },
                { id: 2, total: 49.5, [ROWID]: 2 },
            ])

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)

        expect(response).toBeInstanceOf(Response)
        expect(response.headers.get('Content-Type')).toBe(
            'application/x-sqlite3'
        )
        expect(response.headers.get('Content-Disposition')).toBe(
            'attachment; filename="database_dump.sql"'
        )

        const dump = await response.text()
        expect(dump.startsWith('SQLite format 3\0')).toBe(true)
        expect(dump).toContain('CREATE TABLE users (id INTEGER, name TEXT);')
        expect(dump).toContain(`INSERT INTO "users" VALUES (1, 'Alice');`)
        expect(dump).toContain(`INSERT INTO "users" VALUES (2, 'Bob');`)
        expect(dump).toContain('CREATE TABLE orders (id INTEGER, total REAL);')
        expect(dump).toContain('INSERT INTO "orders" VALUES (1, 99.99);')
        expect(dump).toContain('INSERT INTO "orders" VALUES (2, 49.5);')
        // the internal rowid cursor must never leak into the dump
        expect(dump).not.toContain(ROWID)
    })

    it('paginates large tables with keyset pagination (no OFFSET)', async () => {
        const pageSize = 2
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'items' }])
            .mockResolvedValueOnce([{ sql: 'CREATE TABLE items (id INTEGER)' }])
            // a full page -> another fetch must follow
            .mockResolvedValueOnce([
                { id: 10, [ROWID]: 10 },
                { id: 20, [ROWID]: 20 },
            ])
            // a partial page -> last page
            .mockResolvedValueOnce([{ id: 30, [ROWID]: 30 }])

        const response = await dumpDatabaseRoute(
            mockDataSource,
            mockConfig,
            pageSize
        )
        const dump = await response.text()

        expect(dump).toContain('INSERT INTO "items" VALUES (10);')
        expect(dump).toContain('INSERT INTO "items" VALUES (20);')
        expect(dump).toContain('INSERT INTO "items" VALUES (30);')

        // 1 (tables) + 1 (schema) + 2 (row pages) = 4 calls
        expect(executeOperation).toHaveBeenCalledTimes(4)

        // the second row page must continue via a keyset cursor, not OFFSET
        const secondPage = vi.mocked(executeOperation).mock.calls[3][0][0]
        expect(secondPage.sql).toContain('_rowid_ > ?')
        expect(secondPage.sql).not.toContain('OFFSET')
        expect(secondPage.params).toEqual([20, pageSize])
    })

    it('encodes NULL, numbers, booleans, blobs and escapes quotes', async () => {
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 't' }])
            .mockResolvedValueOnce([{ sql: 'CREATE TABLE t (a, b, c, d, e)' }])
            .mockResolvedValueOnce([
                {
                    a: null,
                    b: 42,
                    c: true,
                    d: "O'Brien",
                    e: new Uint8Array([0xde, 0xad]).buffer,
                    [ROWID]: 1,
                },
            ])

        const dump = await (
            await dumpDatabaseRoute(mockDataSource, mockConfig)
        ).text()

        expect(dump).toContain(
            `INSERT INTO "t" VALUES (NULL, 42, 1, 'O''Brien', X'dead');`
        )
    })

    it('handles an empty database (header only)', async () => {
        vi.mocked(executeOperation).mockResolvedValueOnce([])

        const dump = await (
            await dumpDatabaseRoute(mockDataSource, mockConfig)
        ).text()

        expect(dump).toBe('SQLite format 3\0')
    })

    it('handles a table with no rows', async () => {
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'users' }])
            .mockResolvedValueOnce([{ sql: 'CREATE TABLE users (id INTEGER)' }])
            .mockResolvedValueOnce([])

        const dump = await (
            await dumpDatabaseRoute(mockDataSource, mockConfig)
        ).text()

        expect(dump).toContain('CREATE TABLE users (id INTEGER);')
        expect(dump).not.toContain('INSERT INTO')
    })

    it('falls back to OFFSET pagination for WITHOUT ROWID tables', async () => {
        const pageSize = 2
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'kv' }])
            .mockResolvedValueOnce([
                {
                    sql: 'CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID',
                },
            ])
            .mockResolvedValueOnce([
                { k: 'a', v: '1' },
                { k: 'b', v: '2' },
            ])
            .mockResolvedValueOnce([{ k: 'c', v: '3' }])

        const response = await dumpDatabaseRoute(
            mockDataSource,
            mockConfig,
            pageSize
        )
        const dump = await response.text()

        expect(dump).toContain(`INSERT INTO "kv" VALUES ('a', '1');`)
        expect(dump).toContain(`INSERT INTO "kv" VALUES ('c', '3');`)

        const firstPage = vi.mocked(executeOperation).mock.calls[2][0][0]
        expect(firstPage.sql).toContain('OFFSET')
        expect(firstPage.sql).not.toContain('_rowid_')
    })

    it('returns 500 when the database cannot be read', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        vi.mocked(executeOperation).mockRejectedValue(
            new Error('Database Error')
        )

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)

        expect(response.status).toBe(500)
        const body = (await response.json()) as { error: string }
        expect(body.error).toBe('Failed to create database dump')
    })
})
