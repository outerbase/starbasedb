import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
    dumpDatabaseRoute,
    formatDumpTimestamp,
    formatSqlValue,
} from './dump'
import { executeOperation } from '.'
import { createResponse } from '../utils'
import type { DataSource } from '../types'
import type { StarbaseDBConfiguration } from '../handler'

vi.mock('.', async (importOriginal) => {
    const actual = await importOriginal<typeof import('.')>()
    return {
        ...actual,
        executeOperation: vi.fn(),
    }
})

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
                { sql: 'CREATE TABLE users (id INTEGER, name TEXT)' },
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
                { sql: 'CREATE TABLE users (id INTEGER, bio TEXT)' },
            ])
            .mockResolvedValueOnce([{ id: 1, bio: "Alice's adventure" }])

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)

        expect(response).toBeInstanceOf(Response)
        const dumpText = await response.text()
        expect(dumpText).toContain(
            "INSERT INTO users VALUES (1, 'Alice''s adventure');"
        )
    })

    it('should stream large tables across multiple paginated batches', async () => {
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'events' }])
            .mockResolvedValueOnce([
                { sql: 'CREATE TABLE events (id INTEGER, type TEXT)' },
            ])
            // Batch 1 (full batch of 2)
            .mockResolvedValueOnce([
                { id: 1, type: 'click' },
                { id: 2, type: 'view' },
            ])
            // Batch 2 (full batch of 2)
            .mockResolvedValueOnce([
                { id: 3, type: 'scroll' },
                { id: 4, type: 'submit' },
            ])
            // Batch 3 (partial batch of 1 -> end of table)
            .mockResolvedValueOnce([{ id: 5, type: 'logout' }])

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig, {
            batchSize: 2,
            breathingIntervalMs: 1,
            workSliceMs: 0,
        })

        const reader = response.body!.getReader()
        const decoder = new TextDecoder()
        const chunks: string[] = []
        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            chunks.push(decoder.decode(value, { stream: true }))
        }

        expect(chunks.length).toBeGreaterThanOrEqual(5)
        const fullDump = chunks.join('')
        expect(fullDump).toContain("INSERT INTO events VALUES (1, 'click');")
        expect(fullDump).toContain("INSERT INTO events VALUES (3, 'scroll');")
        expect(fullDump).toContain("INSERT INTO events VALUES (5, 'logout');")

        expect(executeOperation).toHaveBeenNthCalledWith(
            3,
            [{ sql: 'SELECT * FROM events LIMIT 2 OFFSET 0;' }],
            mockDataSource,
            mockConfig
        )
        expect(executeOperation).toHaveBeenNthCalledWith(
            4,
            [{ sql: 'SELECT * FROM events LIMIT 2 OFFSET 2;' }],
            mockDataSource,
            mockConfig
        )
        expect(executeOperation).toHaveBeenNthCalledWith(
            5,
            [{ sql: 'SELECT * FROM events LIMIT 2 OFFSET 4;' }],
            mockDataSource,
            mockConfig
        )
    })

    it('should quote table names with periods and support R2 upload and callback notifications', async () => {
        const mockR2Put = vi.fn().mockResolvedValue(undefined)
        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValue(new Response('ok'))

        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'users.table' }])
            .mockResolvedValueOnce([
                { sql: 'CREATE TABLE "users.table" (id INTEGER, note TEXT)' },
            ])
            .mockResolvedValueOnce([{ id: 1, note: null }])

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig, {
            r2Bucket: { put: mockR2Put } as any,
            r2Key: 'dump_20250101-120000.sql',
            callbackUrl: 'https://example.com/webhook',
        })

        const dumpText = await response.text()
        expect(dumpText).toContain('INSERT INTO "users.table" VALUES (1, NULL);')
        expect(mockR2Put).toHaveBeenCalledWith(
            'dump_20250101-120000.sql',
            dumpText,
            {
                httpMetadata: { contentType: 'application/x-sqlite3' },
            }
        )
        expect(fetchSpy).toHaveBeenCalledWith(
            'https://example.com/webhook',
            expect.objectContaining({
                method: 'POST',
            })
        )
        fetchSpy.mockRestore()
    })

    it('should format SQL values and dump timestamps accurately', () => {
        expect(formatSqlValue(null)).toBe('NULL')
        expect(formatSqlValue(undefined)).toBe('NULL')
        expect(formatSqlValue(true)).toBe('1')
        expect(formatSqlValue(false)).toBe('0')
        expect(formatSqlValue(new Uint8Array([0xde, 0xad]))).toBe("X'dead'")
        expect(formatSqlValue(new Uint8Array([0xbe, 0xef]).buffer)).toBe(
            "X'beef'"
        )
        expect(formatSqlValue({ a: "b'c" })).toBe('\'{"a":"b\'\'c"}\'')
        expect(
            formatDumpTimestamp(new Date(Date.UTC(2024, 0, 1, 17, 0, 0)))
        ).toBe('20240101-170000')
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
        consoleErrorMock.mockRestore()
    })
})
