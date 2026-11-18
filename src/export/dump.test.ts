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
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'users' }, { name: 'orders' }])
            .mockResolvedValueOnce([
                { sql: 'CREATE TABLE users (id INTEGER, name TEXT);' },
            ])
            .mockResolvedValueOnce([
                { id: 1, name: 'Alice' },
                { id: 2, name: 'Bob' },
            ])
            .mockResolvedValueOnce([
                { sql: 'CREATE TABLE orders (id INTEGER, total REAL);' },
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
        expect(dumpText).toContain(
            'CREATE TABLE users (id INTEGER, name TEXT);'
        )
        expect(dumpText).toContain("INSERT INTO users VALUES (1, 'Alice');")
        expect(dumpText).toContain("INSERT INTO users VALUES (2, 'Bob');")
        expect(dumpText).toContain(
            'CREATE TABLE orders (id INTEGER, total REAL);'
        )
        expect(dumpText).toContain('INSERT INTO orders VALUES (1, 99.99);')
        expect(dumpText).toContain('INSERT INTO orders VALUES (2, 49.5);')
    })

    it('should handle empty databases (no tables)', async () => {
        vi.mocked(executeOperation).mockResolvedValueOnce([])

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)

        expect(response).toBeInstanceOf(Response)
        expect(response.headers.get('Content-Type')).toBe(
            'application/x-sqlite3'
        )
        const dumpText = await response.text()
        expect(dumpText).toBe('SQLite format 3\0')
    })

    it('should handle databases with tables but no data', async () => {
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'users' }])
            .mockResolvedValueOnce([
                { sql: 'CREATE TABLE users (id INTEGER, name TEXT);' },
            ])
            .mockResolvedValueOnce([])

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)

        expect(response).toBeInstanceOf(Response)
        const dumpText = await response.text()
        expect(dumpText).toContain(
            'CREATE TABLE users (id INTEGER, name TEXT);'
        )
        expect(dumpText).not.toContain('INSERT INTO users VALUES')
    })

    it('should escape single quotes properly in string values', async () => {
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'users' }])
            .mockResolvedValueOnce([
                { sql: 'CREATE TABLE users (id INTEGER, bio TEXT);' },
            ])
            .mockResolvedValueOnce([{ id: 1, bio: "Alice's adventure" }])

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)

        expect(response).toBeInstanceOf(Response)
        const dumpText = await response.text()
        expect(dumpText).toContain(
            "INSERT INTO users VALUES (1, 'Alice''s adventure');"
        )
    })

    it('should return a 500 response when an error occurs', async () => {
        const consoleErrorMock = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})
        vi.mocked(executeOperation).mockRejectedValue(
            new Error('Database Error')
        )

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)

        expect(response.status).toBe(500)
        const jsonResponse: { error: string } = await response.json()
        expect(jsonResponse.error).toBe('Failed to create database dump')
    })

    it('should paginate large tables in batches and stream the response', async () => {
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'events' }])
            .mockResolvedValueOnce([
                { sql: 'CREATE TABLE events (id INTEGER, label TEXT);' },
            ])
            // Batch 1 (offset 0, limit 2) -> full page
            .mockResolvedValueOnce([
                { id: 1, label: 'first' },
                { id: 2, label: 'second' },
            ])
            // Batch 2 (offset 2, limit 2) -> full page
            .mockResolvedValueOnce([
                { id: 3, label: 'third' },
                { id: 4, label: 'fourth' },
            ])
            // Batch 3 (offset 4, limit 2) -> partial page (< batchSize), stops
            .mockResolvedValueOnce([{ id: 5, label: 'fifth' }])

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig, {
            batchSize: 2,
        })

        expect(response.status).toBe(200)
        expect(response.body).toBeInstanceOf(ReadableStream)

        const dumpText = await response.text()
        expect(dumpText).toContain(
            'CREATE TABLE events (id INTEGER, label TEXT);'
        )
        for (let i = 1; i <= 5; i++) {
            expect(dumpText).toContain(`INSERT INTO events VALUES (${i}, `)
        }

        // Verify exact pagination queries (LIMIT ? OFFSET ?)
        expect(executeOperation).toHaveBeenNthCalledWith(
            3,
            [{ sql: 'SELECT * FROM events LIMIT ? OFFSET ?;', params: [2, 0] }],
            mockDataSource,
            mockConfig
        )
        expect(executeOperation).toHaveBeenNthCalledWith(
            4,
            [{ sql: 'SELECT * FROM events LIMIT ? OFFSET ?;', params: [2, 2] }],
            mockDataSource,
            mockConfig
        )
        expect(executeOperation).toHaveBeenNthCalledWith(
            5,
            [{ sql: 'SELECT * FROM events LIMIT ? OFFSET ?;', params: [2, 4] }],
            mockDataSource,
            mockConfig
        )
    })

    it('should stop paginating when an exact batch multiple ends with an empty page', async () => {
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'items' }])
            .mockResolvedValueOnce([
                { sql: 'CREATE TABLE items (id INTEGER);' },
            ])
            .mockResolvedValueOnce([{ id: 1 }, { id: 2 }])
            .mockResolvedValueOnce([])

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig, {
            batchSize: 2,
        })

        const dumpText = await response.text()
        expect(dumpText).toContain('INSERT INTO items VALUES (1);')
        expect(dumpText).toContain('INSERT INTO items VALUES (2);')
        expect(executeOperation).toHaveBeenCalledTimes(4)
    })

    it('should stream thousands of rows using default batch size without buffering the entire dump', async () => {
        const totalRows = 1250
        const allRows = Array.from({ length: totalRows }, (_, i) => ({
            id: i + 1,
            payload: `row-${i + 1}`,
        }))

        vi.mocked(executeOperation).mockImplementation(async (queries) => {
            const sql = queries[0].sql
            const params = queries[0].params || []
            if (sql.includes('sqlite_master') && sql.includes('SELECT name')) {
                return [{ name: 'big_table' }]
            }
            if (sql.includes('sqlite_master') && sql.includes('SELECT sql')) {
                return [
                    {
                        sql: 'CREATE TABLE big_table (id INTEGER, payload TEXT);',
                    },
                ]
            }
            const [limit, offset] = params
            return allRows.slice(offset, offset + limit)
        })

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)
        const dumpText = await response.text()

        expect(dumpText).toContain("INSERT INTO big_table VALUES (1, 'row-1');")
        expect(dumpText).toContain(
            "INSERT INTO big_table VALUES (500, 'row-500');"
        )
        expect(dumpText).toContain(
            "INSERT INTO big_table VALUES (1250, 'row-1250');"
        )
        // 1 (tables) + 1 (schema) + 3 (batches of 500, 500, 250) = 5 calls
        expect(executeOperation).toHaveBeenCalledTimes(5)
    })

    it('should format NULL, boolean, BLOB values and special table names safely', async () => {
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'user-events' }])
            .mockResolvedValueOnce([
                {
                    sql: 'CREATE TABLE "user-events" (id INTEGER, meta TEXT, active INTEGER, raw BLOB);',
                },
            ])
            .mockResolvedValueOnce([
                {
                    id: 1,
                    meta: null,
                    active: true,
                    raw: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
                },
            ])

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)
        const dumpText = await response.text()

        expect(dumpText).toContain(
            'INSERT INTO "user-events" VALUES (1, NULL, 1, X\'deadbeef\');'
        )
    })

    it('should error the stream if a batch query fails mid-stream', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'users' }])
            .mockResolvedValueOnce([
                { sql: 'CREATE TABLE users (id INTEGER);' },
            ])
            .mockRejectedValueOnce(new Error('Mid-stream RPC failure'))

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)
        await expect(response.text()).rejects.toThrow('Mid-stream RPC failure')
    })

    it('should stop fetching subsequent batches when stream is cancelled', async () => {
        let batchCalls = 0
        vi.mocked(executeOperation).mockImplementation(async (queries) => {
            const sql = queries[0].sql
            if (sql.includes('SELECT name')) {
                return [{ name: 'logs' }]
            }
            if (sql.includes('SELECT sql')) {
                return [{ sql: 'CREATE TABLE logs (id INTEGER);' }]
            }
            batchCalls++
            return [{ id: batchCalls }, { id: batchCalls + 1 }]
        })

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig, {
            batchSize: 2,
        })
        const reader = response.body!.getReader()
        // Read only header + schema chunk, then cancel before fetching all batches
        await reader.read()
        await reader.cancel()

        expect(batchCalls).toBeLessThanOrEqual(1)
    })
})
