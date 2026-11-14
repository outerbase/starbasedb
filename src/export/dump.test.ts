import { describe, it, expect, vi, beforeEach } from 'vitest'
import { dumpDatabaseRoute, formatDumpFilename, DumpJobState } from './dump'
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
        rpc: { executeQuery: vi.fn(), setAlarm: vi.fn() },
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
        consoleErrorMock.mockRestore()
    })

    it('formats R2 dump filenames as dump_YYYYMMDD-HHMMSS.sql', () => {
        const date = new Date('2024-01-01T17:00:00Z')
        expect(formatDumpFilename(date)).toBe('dump_20240101-170000.sql')
    })

    it('paginates large tables in chunks and uploads dump to R2 with callback notification', async () => {
        const putMock = vi.fn().mockResolvedValue(undefined)
        mockDataSource.r2Bucket = { put: putMock }

        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValue(new Response('OK', { status: 200 }))

        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'events' }])
            .mockResolvedValueOnce([
                { sql: 'CREATE TABLE events (id INTEGER, label TEXT);' },
            ])
            // Chunk 1 (2 rows == chunkSize 2)
            .mockResolvedValueOnce([
                { id: 1, label: 'ev1' },
                { id: 2, label: 'ev2' },
            ])
            // Chunk 2 (1 row < chunkSize 2 -> end of table)
            .mockResolvedValueOnce([{ id: 3, label: 'ev3' }])

        const fixedDate = new Date('2024-01-01T17:00:00Z')
        const response = await dumpDatabaseRoute(
            mockDataSource,
            mockConfig,
            undefined,
            {
                chunkSize: 2,
                breathingIntervalMs: 1,
                useR2: true,
                callbackUrl: 'https://example.com/webhook/dump-complete',
                now: fixedDate,
            }
        )

        expect(response.status).toBe(200)
        const body: any = await response.json()
        expect(body.result.status).toBe('completed')
        expect(body.result.fileName).toBe('dump_20240101-170000.sql')
        expect(body.result.tablesExported).toBe(1)

        expect(putMock).toHaveBeenCalledTimes(1)
        const [r2Key, r2Content] = putMock.mock.calls[0]
        expect(r2Key).toBe('dump_20240101-170000.sql')
        expect(r2Content).toContain("INSERT INTO events VALUES (1, 'ev1');")
        expect(r2Content).toContain("INSERT INTO events VALUES (2, 'ev2');")
        expect(r2Content).toContain("INSERT INTO events VALUES (3, 'ev3');")

        expect(fetchSpy).toHaveBeenCalledWith(
            'https://example.com/webhook/dump-complete',
            expect.objectContaining({ method: 'POST' })
        )
        fetchSpy.mockRestore()
    })

    it('pauses and schedules a Durable Object alarm when maxExecutionMs is exceeded, then resumes cleanly', async () => {
        const putMock = vi.fn().mockResolvedValue(undefined)
        mockDataSource.r2Bucket = { put: putMock }

        let savedState: DumpJobState | undefined
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'large_table' }])
            .mockResolvedValueOnce([
                { sql: 'CREATE TABLE large_table (id INTEGER);' },
            ])
            // First batch of 2 rows triggers timeout check
            .mockResolvedValueOnce([{ id: 1 }, { id: 2 }])

        const pauseRes = await dumpDatabaseRoute(
            mockDataSource,
            mockConfig,
            undefined,
            {
                chunkSize: 2,
                maxExecutionMs: -1, // Immediately trigger alarm pause after first chunk
                useR2: true,
                now: new Date('2024-01-01T17:00:00Z'),
                onPauseForAlarm: async (state) => {
                    savedState = state
                },
            }
        )

        expect(pauseRes.status).toBe(202)
        expect(savedState).toBeDefined()
        expect(savedState?.rowOffset).toBe(2)

        // Now resume from savedState for the remaining row
        vi.mocked(executeOperation).mockResolvedValueOnce([{ id: 3 }])

        const resumeRes = await dumpDatabaseRoute(
            mockDataSource,
            mockConfig,
            undefined,
            {
                resumeState: savedState,
                maxExecutionMs: 20000,
                useR2: true,
            }
        )

        expect(resumeRes.status).toBe(200)
        const finalSql = putMock.mock.calls[putMock.mock.calls.length - 1][1]
        expect(finalSql).toContain('INSERT INTO large_table VALUES (1);')
        expect(finalSql).toContain('INSERT INTO large_table VALUES (2);')
        expect(finalSql).toContain('INSERT INTO large_table VALUES (3);')
    })
})
