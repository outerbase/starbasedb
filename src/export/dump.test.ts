import { describe, it, expect, vi, beforeEach } from 'vitest'
import { dumpDatabaseRoute } from './dump'
import { executeOperation } from '.'
import { createResponse } from '../utils'
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

let mockDataSource: DataSource
let mockConfig: StarbaseDBConfiguration

beforeEach(() => {
    vi.clearAllMocks()

    mockDataSource = {
        source: 'external',
        external: { dialect: 'sqlite' },
        rpc: { executeQuery: vi.fn() },
    } as any

    mockConfig = {
        outerbaseApiKey: 'mock-api-key',
        role: 'admin',
        features: { allowlist: true, rls: true, rest: true },
    }
})

describe('Database Dump Module', () => {
    it('should return a database dump when tables exist', async () => {
        // Pagination logic: if rows.length < BATCH_SIZE (1000), stop looping.
        // Both tables return 2 rows → each table needs only 1 batch call.
        //
        // Call order:
        //   0: table list → ['users', 'orders']
        //   1: users schema
        //   2: users data batch (2 rows < 1000 → stops)
        //   3: orders schema
        //   4: orders data batch (2 rows < 1000 → stops)
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'users' }, { name: 'orders' }])
            .mockResolvedValueOnce([
                { sql: 'CREATE TABLE users (id INTEGER, name TEXT)' },
            ])
            .mockResolvedValueOnce([
                { id: 1, name: 'Alice' },
                { id: 2, name: 'Bob' },
            ])
            .mockResolvedValueOnce([
                { sql: 'CREATE TABLE orders (id INTEGER, total REAL)' },
            ])
            .mockResolvedValueOnce([
                { id: 1, total: 99.99 },
                { id: 2, total: 49.5 },
            ])

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)

        expect(response).toBeInstanceOf(Response)
        expect(response.headers.get('Content-Type')).toBe(
            'application/x-sqlite3'
        )
        expect(response.headers.get('Content-Disposition')).toBe(
            'attachment; filename="database_dump.sql"'
        )

        const dumpText = await response.text()
        expect(dumpText).toContain('CREATE TABLE users (id INTEGER, name TEXT)')
        expect(dumpText).toContain('INSERT INTO "users" VALUES (1, \'Alice\');')
        expect(dumpText).toContain('INSERT INTO "users" VALUES (2, \'Bob\');')
        expect(dumpText).toContain(
            'CREATE TABLE orders (id INTEGER, total REAL)'
        )
        expect(dumpText).toContain('INSERT INTO "orders" VALUES (1, 99.99);')
        expect(dumpText).toContain('INSERT INTO "orders" VALUES (2, 49.5);')
        // dump must be wrapped in a transaction
        expect(dumpText).toContain('BEGIN TRANSACTION;')
        expect(dumpText).toContain('COMMIT;')
    })

    it('should handle empty databases (no tables)', async () => {
        vi.mocked(executeOperation).mockResolvedValueOnce([])

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)

        expect(response).toBeInstanceOf(Response)
        expect(response.headers.get('Content-Type')).toBe(
            'application/x-sqlite3'
        )
        const dumpText = await response.text()
        // Should still contain header comment and transaction markers
        expect(dumpText).toContain('StarbaseDB SQL dump')
        expect(dumpText).toContain('BEGIN TRANSACTION;')
        expect(dumpText).toContain('COMMIT;')
    })

    it('should handle databases with tables but no data', async () => {
        // data batch returns 0 rows → exits immediately
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'users' }])
            .mockResolvedValueOnce([
                { sql: 'CREATE TABLE users (id INTEGER, name TEXT)' },
            ])
            .mockResolvedValueOnce([])

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)

        expect(response).toBeInstanceOf(Response)
        const dumpText = await response.text()
        expect(dumpText).toContain('CREATE TABLE users (id INTEGER, name TEXT)')
        expect(dumpText).not.toContain('INSERT INTO')
    })

    it('should escape single quotes properly in string values', async () => {
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'users' }])
            .mockResolvedValueOnce([
                { sql: 'CREATE TABLE users (id INTEGER, bio TEXT)' },
            ])
            // 1 row → length 1 < 1000 → stops after first batch
            .mockResolvedValueOnce([{ id: 1, bio: "Alice's adventure" }])

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)

        expect(response).toBeInstanceOf(Response)
        const dumpText = await response.text()
        expect(dumpText).toContain(
            "INSERT INTO \"users\" VALUES (1, 'Alice''s adventure');"
        )
    })

    it('should handle NULL values correctly', async () => {
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'users' }])
            .mockResolvedValueOnce([
                { sql: 'CREATE TABLE users (id INTEGER, name TEXT)' },
            ])
            .mockResolvedValueOnce([{ id: 1, name: null }])

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)
        const dumpText = await response.text()
        expect(dumpText).toContain('INSERT INTO "users" VALUES (1, NULL);')
    })

    it('should handle boolean values as 1/0', async () => {
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'flags' }])
            .mockResolvedValueOnce([
                { sql: 'CREATE TABLE flags (id INTEGER, active INTEGER)' },
            ])
            .mockResolvedValueOnce([
                { id: 1, active: true },
                { id: 2, active: false },
            ])

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)
        const dumpText = await response.text()
        expect(dumpText).toContain('INSERT INTO "flags" VALUES (1, 1);')
        expect(dumpText).toContain('INSERT INTO "flags" VALUES (2, 0);')
    })

    it('should paginate large tables across multiple batches', async () => {
        // Simulate a table with exactly BATCH_SIZE (1000) rows in first batch,
        // then 500 rows in second batch (signals end-of-data since 500 < 1000).
        const firstBatch = Array.from({ length: 1000 }, (_, i) => ({
            id: i + 1,
            val: `row${i + 1}`,
        }))
        const secondBatch = Array.from({ length: 500 }, (_, i) => ({
            id: 1001 + i,
            val: `row${1001 + i}`,
        }))

        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'big_table' }])
            .mockResolvedValueOnce([
                { sql: 'CREATE TABLE big_table (id INTEGER, val TEXT)' },
            ])
            // first batch: full 1000 rows → pagination continues
            .mockResolvedValueOnce(firstBatch)
            // second batch: 500 rows < 1000 → stops pagination
            .mockResolvedValueOnce(secondBatch)

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)
        const dumpText = await response.text()

        // Rows from both batches should appear
        expect(dumpText).toContain(
            'INSERT INTO "big_table" VALUES (1, \'row1\');'
        )
        expect(dumpText).toContain(
            'INSERT INTO "big_table" VALUES (1000, \'row1000\');'
        )
        expect(dumpText).toContain(
            'INSERT INTO "big_table" VALUES (1001, \'row1001\');'
        )
        expect(dumpText).toContain(
            'INSERT INTO "big_table" VALUES (1500, \'row1500\');'
        )
    })

    it('should return a 500 response when an error occurs during setup', async () => {
        const consoleErrorMock = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})
        // Reject the very first call (table list) so the outer try-catch fires
        vi.mocked(executeOperation).mockRejectedValue(
            new Error('Database Error')
        )

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)

        expect(response.status).toBe(500)
        const jsonResponse: { error: string } = await response.json()
        expect(jsonResponse.error).toBe('Failed to create database dump')
    })
})
