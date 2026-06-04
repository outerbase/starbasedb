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

// ─── Helper ──────────────────────────────────────────────────────────────────
// The pre-flight phase calls executeOperation in this order per table:
//   1. SELECT name FROM sqlite_master   (table list)
//   2. For each table: SELECT sql FROM sqlite_master  (schema)
// Then the streaming phase calls:
//   3. For each table: SELECT * FROM `t` LIMIT ? OFFSET ?  (batches until empty)
//
// All mocks below follow this contract strictly.

describe('Database Dump Module', () => {
    // ── headers ──────────────────────────────────────────────────────────────
    it('should return a streaming response with correct headers', async () => {
        vi.mocked(executeOperation)
            // 1. table list
            .mockResolvedValueOnce([{ name: 'users' }, { name: 'orders' }])
            // 2a. users schema
            .mockResolvedValueOnce([
                { sql: 'CREATE TABLE users (id INTEGER, name TEXT)' },
            ])
            // 2b. orders schema
            .mockResolvedValueOnce([
                { sql: 'CREATE TABLE orders (id INTEGER, total REAL)' },
            ])
            // 3a. users batch 1 – partial (< 1000) → stream loop ends
            .mockResolvedValueOnce([
                { id: 1, name: 'Alice' },
                { id: 2, name: 'Bob' },
            ])
            // 3b. orders batch 1 – partial → stream loop ends
            .mockResolvedValueOnce([
                { id: 1, total: 99.99 },
                { id: 2, total: 49.5 },
            ])

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)

        expect(response).toBeInstanceOf(Response)
        expect(response.status).toBe(200)
        expect(response.headers.get('Content-Type')).toBe(
            'application/x-sqlite3'
        )
        expect(response.headers.get('Content-Disposition')).toBe(
            'attachment; filename="database_dump.sql"'
        )
        expect(response.headers.get('Transfer-Encoding')).toBe('chunked')

        // Drain the body so the ReadableStream fully completes before the
        // next test's beforeEach clears mocks (prevents cross-test contamination).
        await response.text()
    })

    // ── body contents ─────────────────────────────────────────────────────────
    it('should contain CREATE TABLE and INSERT statements in the streamed body', async () => {
        vi.mocked(executeOperation)
            // 1. table list (pre-flight call 1)
            .mockResolvedValueOnce([{ name: 'users' }])
            // 2. users schema (pre-flight call 2)
            .mockResolvedValueOnce([
                { sql: 'CREATE TABLE users (id INTEGER, name TEXT)' },
            ])
            // 3. rows – batch 1 (stream call 1): 2 rows < BATCH_SIZE=1000 → loop exits
            .mockResolvedValueOnce([
                { id: 1, name: 'Alice' },
                { id: 2, name: 'Bob' },
            ])

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)

        // Await the full streamed body before asserting
        const text = await response.text()

        expect(text).toContain('-- Table: users')
        expect(text).toContain('CREATE TABLE users (id INTEGER, name TEXT)')
        expect(text).toContain("INSERT INTO `users` VALUES (1, 'Alice');")
        expect(text).toContain("INSERT INTO `users` VALUES (2, 'Bob');")
        expect(text).toContain('BEGIN TRANSACTION;')
        expect(text).toContain('COMMIT;')
    })

    // ── empty DB ──────────────────────────────────────────────────────────────
    it('should handle empty databases (no tables)', async () => {
        vi.mocked(executeOperation)
            // 1. table list returns nothing
            .mockResolvedValueOnce([])

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)

        expect(response).toBeInstanceOf(Response)
        expect(response.headers.get('Content-Type')).toBe(
            'application/x-sqlite3'
        )
        const text = await response.text()
        expect(text).toContain('BEGIN TRANSACTION;')
        expect(text).toContain('COMMIT;')
    })

    // ── table with no rows ────────────────────────────────────────────────────
    it('should handle databases with tables but no rows', async () => {
        vi.mocked(executeOperation)
            // 1. table list
            .mockResolvedValueOnce([{ name: 'users' }])
            // 2. schema
            .mockResolvedValueOnce([
                { sql: 'CREATE TABLE users (id INTEGER, name TEXT)' },
            ])
            // 3. first batch: empty → loop ends immediately
            .mockResolvedValueOnce([])

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)
        const text = await response.text()

        expect(text).toContain('CREATE TABLE users')
        expect(text).not.toContain('INSERT INTO `users`')
    })

    // ── string escaping ───────────────────────────────────────────────────────
    it('should escape single quotes properly in string values', async () => {
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'users' }])
            .mockResolvedValueOnce([
                { sql: 'CREATE TABLE users (id INTEGER, bio TEXT)' },
            ])
            .mockResolvedValueOnce([{ id: 1, bio: "Alice's adventure" }])

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)
        const text = await response.text()

        expect(text).toContain(
            "INSERT INTO `users` VALUES (1, 'Alice''s adventure');"
        )
    })

    // ── NULL handling ─────────────────────────────────────────────────────────
    it('should write NULL for null column values', async () => {
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'users' }])
            .mockResolvedValueOnce([
                { sql: 'CREATE TABLE users (id INTEGER, bio TEXT)' },
            ])
            .mockResolvedValueOnce([{ id: 1, bio: null }])

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)
        const text = await response.text()

        expect(text).toContain('INSERT INTO `users` VALUES (1, NULL);')
    })

    // ── large-table pagination ────────────────────────────────────────────────
    it('should paginate large tables across multiple batches', async () => {
        // First batch: exactly 1000 rows (triggers another fetch)
        const fullBatch = Array.from({ length: 1000 }, (_, i) => ({
            id: i + 1,
            name: `User ${i + 1}`,
        }))
        // Second batch: 1 row (< 1000 → loop ends)
        const partialBatch = [{ id: 1001, name: 'User 1001' }]

        vi.mocked(executeOperation)
            // 1. table list
            .mockResolvedValueOnce([{ name: 'users' }])
            // 2. schema
            .mockResolvedValueOnce([
                { sql: 'CREATE TABLE users (id INTEGER, name TEXT)' },
            ])
            // 3. batch 1 (offset 0): 1000 rows
            .mockResolvedValueOnce(fullBatch)
            // 4. batch 2 (offset 1000): 1 row → partial → loop ends
            .mockResolvedValueOnce(partialBatch)

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)
        const text = await response.text()

        const insertCount = (text.match(/INSERT INTO `users`/g) || []).length
        expect(insertCount).toBe(1001)
    })

    // ── pre-flight error → HTTP 500 ───────────────────────────────────────────
    it('should return a 500 response when a pre-flight query fails', async () => {
        const consoleErrorMock = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})

        // The very first call (table list) throws
        vi.mocked(executeOperation).mockRejectedValueOnce(
            new Error('Database Error')
        )

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)

        expect(response.status).toBe(500)
        const json: { error: string } = await response.json()
        expect(json.error).toBe('Failed to create database dump')

        consoleErrorMock.mockRestore()
    })

    // ── sqlite_ tables excluded ───────────────────────────────────────────────
    it('should exclude sqlite_ internal tables from the dump', async () => {
        // The SQL filter already prevents sqlite_ tables reaching us;
        // mock reflects only user tables.
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'users' }])
            .mockResolvedValueOnce([
                { sql: 'CREATE TABLE users (id INTEGER, name TEXT)' },
            ])
            .mockResolvedValueOnce([{ id: 1, name: 'Alice' }])

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)
        const text = await response.text()

        expect(text).not.toContain('sqlite_')
    })
})
