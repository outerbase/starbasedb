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
let mockR2Bucket: any
let mockFetch: any

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

    mockR2Bucket = {
        createMultipartUpload: vi.fn().mockResolvedValue({
            uploadPart: vi.fn().mockResolvedValue({ etag: 'mock-etag' }),
            complete: vi.fn().mockResolvedValue(undefined),
            abort: vi.fn().mockResolvedValue(undefined),
        }),
    }

    mockFetch = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }))
    vi.stubGlobal('fetch', mockFetch)
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

        const req = new Request('http://localhost/export/dump')
        const response = await dumpDatabaseRoute(
            req,
            mockDataSource,
            mockConfig
        )

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
        expect(dumpText).toContain('INSERT INTO "users" VALUES (1, \'Alice\');')
        expect(dumpText).toContain('INSERT INTO "users" VALUES (2, \'Bob\');')
        expect(dumpText).toContain(
            'CREATE TABLE orders (id INTEGER, total REAL);'
        )
        expect(dumpText).toContain('INSERT INTO "orders" VALUES (1, 99.99);')
        expect(dumpText).toContain('INSERT INTO "orders" VALUES (2, 49.5);')
    })

    it('should handle empty databases (no tables)', async () => {
        vi.mocked(executeOperation).mockResolvedValueOnce([])

        const req = new Request('http://localhost/export/dump')
        const response = await dumpDatabaseRoute(
            req,
            mockDataSource,
            mockConfig
        )

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

        const req = new Request('http://localhost/export/dump')
        const response = await dumpDatabaseRoute(
            req,
            mockDataSource,
            mockConfig
        )

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

        const req = new Request('http://localhost/export/dump')
        const response = await dumpDatabaseRoute(
            req,
            mockDataSource,
            mockConfig
        )

        expect(response).toBeInstanceOf(Response)
        const dumpText = await response.text()
        expect(dumpText).toContain(
            "INSERT INTO \"users\" VALUES (1, 'Alice''s adventure');"
        )
    })

    it('should return a 500 response when an error occurs', async () => {
        const consoleErrorMock = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})
        vi.mocked(executeOperation).mockRejectedValue(
            new Error('Database Error')
        )

        const req = new Request('http://localhost/export/dump')
        const response = await dumpDatabaseRoute(
            req,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(500)
        const jsonResponse: { error: string } = await response.json()
        expect(jsonResponse.error).toBe('Failed to create database dump')
        consoleErrorMock.mockRestore()
    })

    it('should return a 400 response when async is requested but bucket is missing', async () => {
        const req = new Request('http://localhost/export/dump?async=true')
        const response = await dumpDatabaseRoute(
            req,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(400)
        const jsonResponse = (await response.json()) as any
        expect(jsonResponse.error).toContain(
            'require an EXPORT_BUCKET R2 binding'
        )
    })

    it('should trigger background R2 dump when async is requested', async () => {
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'users' }])
            .mockResolvedValueOnce([
                { sql: 'CREATE TABLE users (id INTEGER, name TEXT);' },
            ])
            .mockResolvedValueOnce([{ id: 1, name: 'Alice' }])

        const configWithBucket: StarbaseDBConfiguration = {
            ...mockConfig,
            export: {
                bucket: mockR2Bucket,
                callbackUrl: 'http://callback.url/notify',
                chunkSize: 100,
            },
        }

        const mockExecutionContext = {
            waitUntil: vi.fn(),
        } as any

        const req = new Request(
            'http://localhost/export/dump?async=true&filename=test-dump.sql'
        )
        const response = await dumpDatabaseRoute(
            req,
            mockDataSource,
            configWithBucket,
            mockExecutionContext
        )

        expect(response.status).toBe(202)
        const jsonResponse = (await response.json()) as any
        expect(jsonResponse.result.status).toBe('running')
        expect(jsonResponse.result.filename).toBe('test-dump.sql')

        expect(mockExecutionContext.waitUntil).toHaveBeenCalled()
        const backgroundPromise =
            mockExecutionContext.waitUntil.mock.calls[0][0]

        // Await the background process
        await backgroundPromise

        // Verify R2 was used
        expect(mockR2Bucket.createMultipartUpload).toHaveBeenCalledWith(
            'test-dump.sql',
            {
                httpMetadata: { contentType: 'application/sql' },
            }
        )

        // Verify callback url notified
        expect(mockFetch).toHaveBeenCalledWith(
            'http://callback.url/notify',
            expect.objectContaining({
                method: 'POST',
                body: expect.stringContaining('"status":"completed"'),
            })
        )
    })
})
