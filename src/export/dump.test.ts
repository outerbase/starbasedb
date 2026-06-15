import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
    dumpDatabaseRoute,
    generateDumpChunks,
    escapeSqlValue,
    formatDumpTimestamp,
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
    vi.unstubAllGlobals()

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
        consoleErrorMock.mockRestore()
    })
})

describe('escapeSqlValue', () => {
    it('should render null and undefined as NULL', () => {
        expect(escapeSqlValue(null)).toBe('NULL')
        expect(escapeSqlValue(undefined)).toBe('NULL')
    })

    it('should render numbers and booleans without quotes', () => {
        expect(escapeSqlValue(42)).toBe('42')
        expect(escapeSqlValue(3.14)).toBe('3.14')
        expect(escapeSqlValue(true)).toBe('1')
        expect(escapeSqlValue(false)).toBe('0')
    })

    it('should render binary BLOB values as hex literals', () => {
        const blob = new Uint8Array([0x00, 0x0f, 0xff])
        expect(escapeSqlValue(blob)).toBe("X'000fff'")
    })

    it('should escape embedded single quotes in strings', () => {
        expect(escapeSqlValue("O'Brien")).toBe("'O''Brien'")
    })
})

describe('formatDumpTimestamp', () => {
    it('should format a date as YYYYMMDD-HHMMSS in UTC', () => {
        expect(formatDumpTimestamp(new Date('2024-01-01T17:00:00Z'))).toBe(
            '20240101-170000'
        )
    })

    it('should zero-pad single digit components', () => {
        expect(formatDumpTimestamp(new Date('2024-03-05T07:08:09Z'))).toBe(
            '20240305-070809'
        )
    })
})

describe('generateDumpChunks pagination', () => {
    it('should page through table data without loading it all at once', async () => {
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ sql: 'CREATE TABLE t (id INTEGER);' }])
            .mockResolvedValueOnce([{ id: 1 }, { id: 2 }])
            .mockResolvedValueOnce([{ id: 3 }])

        const chunks: string[] = []
        for await (const chunk of generateDumpChunks(
            ['t'],
            mockDataSource,
            mockConfig,
            2
        )) {
            chunks.push(chunk)
        }

        const dump = chunks.join('')
        expect(dump).toContain('INSERT INTO t VALUES (1);')
        expect(dump).toContain('INSERT INTO t VALUES (2);')
        expect(dump).toContain('INSERT INTO t VALUES (3);')

        // schema query + two paged data queries (offset 0, then offset 2)
        const calls = vi.mocked(executeOperation).mock.calls
        expect(calls).toHaveLength(3)
        expect(calls[1][0][0].sql).toContain('OFFSET 0')
        expect(calls[2][0][0].sql).toContain('OFFSET 2')
    })
})

describe('Database Dump R2 offload', () => {
    function createMockUpload() {
        return {
            uploadPart: vi.fn((partNumber: number) =>
                Promise.resolve({ partNumber, etag: `etag-${partNumber}` })
            ),
            complete: vi.fn().mockResolvedValue({}),
            abort: vi.fn().mockResolvedValue(undefined),
        }
    }

    it('should stream the dump into an R2 multipart object', async () => {
        const upload = createMockUpload()
        const bucket = {
            createMultipartUpload: vi.fn().mockResolvedValue(upload),
        }
        mockDataSource.dumpBucket = bucket as any

        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'logs' }])
            .mockResolvedValueOnce([{ sql: 'CREATE TABLE logs (id INTEGER);' }])
            .mockResolvedValueOnce([{ id: 1 }])

        const request = new Request(
            'https://example.com/export/dump?location=r2'
        )
        const response = await dumpDatabaseRoute(
            mockDataSource,
            mockConfig,
            request
        )

        expect(response.status).toBe(200)
        const body: { result: { key: string; status: string } } =
            await response.json()
        expect(body.result.key).toMatch(/^dump_\d{8}-\d{6}\.sql$/)
        expect(body.result.status).toBe('completed')

        expect(bucket.createMultipartUpload).toHaveBeenCalledWith(
            body.result.key
        )
        expect(upload.uploadPart).toHaveBeenCalledTimes(1)
        expect(upload.complete).toHaveBeenCalledWith([
            { partNumber: 1, etag: 'etag-1' },
        ])
    })

    it('should notify the callback URL once the upload completes', async () => {
        const upload = createMockUpload()
        const bucket = {
            createMultipartUpload: vi.fn().mockResolvedValue(upload),
        }
        mockDataSource.dumpBucket = bucket as any

        const fetchMock = vi.fn().mockResolvedValue(new Response('ok'))
        vi.stubGlobal('fetch', fetchMock)

        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'logs' }])
            .mockResolvedValueOnce([{ sql: 'CREATE TABLE logs (id INTEGER);' }])
            .mockResolvedValueOnce([])

        const request = new Request(
            'https://example.com/export/dump?location=r2&callback=https://hooks.example.com/done'
        )
        await dumpDatabaseRoute(mockDataSource, mockConfig, request)

        expect(fetchMock).toHaveBeenCalledTimes(1)
        const [calledUrl, calledInit] = fetchMock.mock.calls[0]
        expect(calledUrl).toBe('https://hooks.example.com/done')
        expect(calledInit.method).toBe('POST')
        expect(JSON.parse(calledInit.body).status).toBe('completed')
    })

    it('should return 202 and run in the background when an execution context is present', async () => {
        const upload = createMockUpload()
        const bucket = {
            createMultipartUpload: vi.fn().mockResolvedValue(upload),
        }
        const pending: Promise<unknown>[] = []
        mockDataSource.dumpBucket = bucket as any
        mockDataSource.executionContext = {
            waitUntil: vi.fn((p: Promise<unknown>) => pending.push(p)),
        } as any

        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'logs' }])
            .mockResolvedValueOnce([{ sql: 'CREATE TABLE logs (id INTEGER);' }])
            .mockResolvedValueOnce([])

        const request = new Request(
            'https://example.com/export/dump?location=r2'
        )
        const response = await dumpDatabaseRoute(
            mockDataSource,
            mockConfig,
            request
        )

        expect(response.status).toBe(202)
        expect(
            mockDataSource.executionContext!.waitUntil
        ).toHaveBeenCalledTimes(1)

        // Let the backgrounded upload settle so assertions are deterministic.
        await Promise.all(pending)
        expect(upload.complete).toHaveBeenCalledTimes(1)
    })

    it('should return 400 when R2 offload is requested without a bucket binding', async () => {
        vi.mocked(executeOperation).mockResolvedValueOnce([])

        const request = new Request(
            'https://example.com/export/dump?location=r2'
        )
        const response = await dumpDatabaseRoute(
            mockDataSource,
            mockConfig,
            request
        )

        expect(response.status).toBe(400)
        const body: { error: string } = await response.json()
        expect(body.error).toContain('DATABASE_DUMP_BUCKET')
    })
})
