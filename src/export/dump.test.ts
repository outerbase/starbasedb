import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
    dumpDatabaseRoute,
    escapeSqlValue,
    formatDumpTimestamp,
    generateDumpChunks,
    uploadDumpToR2,
} from './dump'
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
    describe('formatDumpTimestamp', () => {
        it('should format UTC date components with zero-padding', () => {
            const date = new Date(Date.UTC(2024, 0, 5, 8, 9, 7))
            expect(formatDumpTimestamp(date)).toBe('20240105-080907')
        })

        it('should handle double digit months and days', () => {
            const date = new Date(Date.UTC(2024, 11, 25, 23, 59, 59))
            expect(formatDumpTimestamp(date)).toBe('20241225-235959')
        })
    })

    describe('escapeSqlValue', () => {
        it('should format null and undefined as NULL', () => {
            expect(escapeSqlValue(null)).toBe('NULL')
            expect(escapeSqlValue(undefined)).toBe('NULL')
        })

        it('should format numbers and bigints as unquoted strings', () => {
            expect(escapeSqlValue(42)).toBe('42')
            expect(escapeSqlValue(3.14159)).toBe('3.14159')
            expect(escapeSqlValue(BigInt(9007199254740991))).toBe(
                '9007199254740991'
            )
        })

        it('should format booleans as 1 and 0', () => {
            expect(escapeSqlValue(true)).toBe('1')
            expect(escapeSqlValue(false)).toBe('0')
        })

        it('should format ArrayBuffer and Uint8Array as hex literals', () => {
            const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef])
            expect(escapeSqlValue(bytes)).toBe("X'deadbeef'")
            expect(escapeSqlValue(bytes.buffer)).toBe("X'deadbeef'")
        })

        it('should escape single quotes inside string values', () => {
            expect(escapeSqlValue("Alice's book")).toBe("'Alice''s book'")
            expect(escapeSqlValue("O''Reilly")).toBe("'O''''Reilly'")
            expect(escapeSqlValue('Simple text')).toBe("'Simple text'")
        })
    })

    describe('generateDumpChunks', () => {
        it('should paginate table rows using LIMIT and OFFSET', async () => {
            const tables = ['users']

            vi.mocked(executeOperation)
                // Schema query
                .mockResolvedValueOnce([
                    { sql: 'CREATE TABLE users (id INTEGER, name TEXT);' },
                ])
                // First page (pageSize = 2)
                .mockResolvedValueOnce([
                    { id: 1, name: 'Alice' },
                    { id: 2, name: 'Bob' },
                ])
                // Second page
                .mockResolvedValueOnce([{ id: 3, name: 'Charlie' }])

            const chunks: string[] = []
            for await (const chunk of generateDumpChunks(
                tables,
                mockDataSource,
                mockConfig,
                2
            )) {
                chunks.push(chunk)
            }

            const fullDump = chunks.join('')
            expect(fullDump).toContain('SQLite format 3\0')
            expect(fullDump).toContain(
                'CREATE TABLE users (id INTEGER, name TEXT);'
            )
            expect(fullDump).toContain("INSERT INTO users VALUES (1, 'Alice');")
            expect(fullDump).toContain("INSERT INTO users VALUES (2, 'Bob');")
            expect(fullDump).toContain(
                "INSERT INTO users VALUES (3, 'Charlie');"
            )

            // Verify LIMIT and OFFSET were queried
            expect(executeOperation).toHaveBeenCalledWith(
                [{ sql: 'SELECT * FROM "users" LIMIT 2 OFFSET 0;' }],
                mockDataSource,
                mockConfig
            )
            expect(executeOperation).toHaveBeenCalledWith(
                [{ sql: 'SELECT * FROM "users" LIMIT 2 OFFSET 2;' }],
                mockDataSource,
                mockConfig
            )
        })
    })

    describe('dumpDatabaseRoute streaming', () => {
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
            vi.spyOn(console, 'error').mockImplementation(() => {})
            vi.mocked(executeOperation).mockRejectedValue(
                new Error('Database Error')
            )

            const response = await dumpDatabaseRoute(mockDataSource, mockConfig)

            expect(response.status).toBe(500)
            const jsonResponse: { error: string } = await response.json()
            expect(jsonResponse.error).toBe('Failed to create database dump')
        })
    })

    describe('R2 Offload and uploadDumpToR2', () => {
        it('should return 400 when location=r2 is requested without a bucket binding', async () => {
            vi.mocked(executeOperation).mockResolvedValueOnce([])

            const request = new Request(
                'https://api.starbasedb.com/export/dump?location=r2'
            )
            const response = await dumpDatabaseRoute(
                mockDataSource,
                mockConfig,
                request
            )

            expect(response.status).toBe(400)
            const body = (await response.json()) as any
            expect(body.error).toContain('DATABASE_DUMP_BUCKET')
        })

        it('should execute multipart upload to R2 and trigger callback URL if provided', async () => {
            const mockUploadPart = vi.fn().mockImplementation((partNumber) => ({
                partNumber,
                etag: `etag-${partNumber}`,
            }))
            const mockComplete = vi.fn().mockResolvedValue({})
            const mockAbort = vi.fn().mockResolvedValue({})

            const mockBucket = {
                createMultipartUpload: vi.fn().mockResolvedValue({
                    uploadPart: mockUploadPart,
                    complete: mockComplete,
                    abort: mockAbort,
                }),
            } as any

            const fetchSpy = vi
                .spyOn(globalThis, 'fetch')
                .mockResolvedValue(new Response('OK'))

            vi.mocked(executeOperation)
                .mockResolvedValueOnce([
                    { sql: 'CREATE TABLE users (id INT);' },
                ])
                .mockResolvedValueOnce([{ id: 1 }])

            await uploadDumpToR2(
                mockBucket,
                'dump_test.sql',
                ['users'],
                mockDataSource,
                mockConfig,
                'https://webhook.site/test'
            )

            expect(mockBucket.createMultipartUpload).toHaveBeenCalledWith(
                'dump_test.sql'
            )
            expect(mockUploadPart).toHaveBeenCalled()
            expect(mockComplete).toHaveBeenCalled()
            expect(fetchSpy).toHaveBeenCalledWith(
                'https://webhook.site/test',
                expect.objectContaining({
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                })
            )
        })

        it('should abort multipart upload if an error occurs during uploadDumpToR2', async () => {
            vi.spyOn(console, 'error').mockImplementation(() => {})
            const mockAbort = vi.fn().mockResolvedValue({})
            const mockBucket = {
                createMultipartUpload: vi.fn().mockResolvedValue({
                    uploadPart: vi
                        .fn()
                        .mockRejectedValue(new Error('Network upload failed')),
                    complete: vi.fn(),
                    abort: mockAbort,
                }),
            } as any

            vi.mocked(executeOperation).mockRejectedValue(
                new Error('Query execution error')
            )

            await expect(
                uploadDumpToR2(
                    mockBucket,
                    'dump_failed.sql',
                    ['users'],
                    mockDataSource,
                    mockConfig
                )
            ).rejects.toThrow('Query execution error')

            expect(mockAbort).toHaveBeenCalled()
        })

        it('should return 202 Accepted when executionContext.waitUntil is available', async () => {
            const waitUntil = vi.fn()
            const mockBucket = {
                createMultipartUpload: vi.fn().mockResolvedValue({
                    uploadPart: vi.fn().mockResolvedValue({
                        partNumber: 1,
                        etag: 'etag-1',
                    }),
                    complete: vi.fn().mockResolvedValue({}),
                    abort: vi.fn(),
                }),
            } as any

            mockDataSource.dumpBucket = mockBucket
            mockDataSource.executionContext = { waitUntil } as any

            vi.mocked(executeOperation).mockResolvedValueOnce([])

            const request = new Request(
                'https://api.starbasedb.com/export/dump?location=r2'
            )
            const response = await dumpDatabaseRoute(
                mockDataSource,
                mockConfig,
                request
            )

            expect(response.status).toBe(202)
            const body = (await response.json()) as any
            expect(body.result.status).toBe('accepted')
            expect(body.result.key).toMatch(/^dump_\d{8}-\d{6}\.sql$/)
            expect(waitUntil).toHaveBeenCalled()
        })
    })
})
