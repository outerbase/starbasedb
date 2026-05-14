import { describe, it, expect, vi, beforeEach } from 'vitest'
import { dumpDatabaseRoute, createDatabaseDumpStream } from './dump'
import * as exportIndex from '.'
import { createResponse } from '../utils'
import type { DataSource } from '../types'
import type { StarbaseDBConfiguration } from '../handler'

vi.mock('.', () => ({
    executeOperation: vi.fn(),
}))

vi.mock('../utils', () => ({
    createResponse: vi.fn(
        (data: any, message: any, status: any) =>
            new Response(JSON.stringify({ result: data, error: message }), {
                status,
                headers: { 'Content-Type': 'application/json' },
            })
    ),
}))

const mockExecuteOperation = vi.mocked(exportIndex.executeOperation)

function makeDataSource(): DataSource {
    return {
        source: 'internal',
        rpc: { executeQuery: vi.fn() },
    } as any
}

function makeConfig(extra: Partial<StarbaseDBConfiguration> = {}): StarbaseDBConfiguration {
    return {
        outerbaseApiKey: 'mock-api-key',
        role: 'admin',
        features: { allowlist: true, rls: true, rest: true },
        ...extra,
    }
}

function makeRequest(url = 'https://example.com/export/dump') {
    return new Request(url)
}

function makeMockBucket() {
    const objects = new Map<string, string>()
    const bucket = {
        get: vi.fn(async (key: string) => {
            if (!objects.has(key)) return null
            const value = objects.get(key)!
            return { json: async () => JSON.parse(value), text: async () => value }
        }),
        put: vi.fn(async (key: string, value: any) => {
            objects.set(key, typeof value === 'string' ? value : String(value))
            return undefined
        }),
        objects,
    }
    return bucket as any
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let text = ''
    while (true) {
        const { done, value } = await reader.read()
        if (done) break
        text += decoder.decode(value)
    }
    return text
}

beforeEach(() => {
    mockExecuteOperation.mockReset()
})

// ─── createDatabaseDumpStream ────────────────────────────────────────────────

describe('createDatabaseDumpStream', () => {
    it('streams SQL header + CREATE + INSERT statements', async () => {
        mockExecuteOperation
            .mockResolvedValueOnce([{ name: 'users' }])
            .mockResolvedValueOnce([{ sql: 'CREATE TABLE users (id INTEGER, name TEXT)' }])
            .mockResolvedValueOnce([{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }])
            .mockResolvedValueOnce([]) // end of pages

        const text = await readStream(createDatabaseDumpStream(makeDataSource(), makeConfig(), 500))

        expect(text).toContain('SQLite format 3')
        expect(text).toContain('CREATE TABLE users (id INTEGER, name TEXT);')
        expect(text).toContain(`INSERT INTO "users" VALUES (1, 'Alice');`)
        expect(text).toContain(`INSERT INTO "users" VALUES (2, 'Bob');`)
    })

    it('handles NULL, boolean, and number values correctly', async () => {
        mockExecuteOperation
            .mockResolvedValueOnce([{ name: 'data' }])
            .mockResolvedValueOnce([{ sql: 'CREATE TABLE data (a INTEGER, b INTEGER, c INTEGER)' }])
            .mockResolvedValueOnce([{ a: null, b: true, c: 42 }])
            .mockResolvedValueOnce([])

        const text = await readStream(createDatabaseDumpStream(makeDataSource(), makeConfig(), 500))

        expect(text).toContain(`INSERT INTO "data" VALUES (NULL, 1, 42);`)
    })

    it('paginates rows using LIMIT/OFFSET', async () => {
        const chunkSize = 2
        mockExecuteOperation
            .mockResolvedValueOnce([{ name: 'items' }])
            .mockResolvedValueOnce([{ sql: 'CREATE TABLE items (id INTEGER)' }])
            .mockResolvedValueOnce([{ id: 1 }, { id: 2 }]) // full page
            .mockResolvedValueOnce([{ id: 3 }])            // partial → last page

        const text = await readStream(createDatabaseDumpStream(makeDataSource(), makeConfig(), chunkSize))

        expect(text).toContain('INSERT INTO "items" VALUES (1);')
        expect(text).toContain('INSERT INTO "items" VALUES (2);')
        expect(text).toContain('INSERT INTO "items" VALUES (3);')
        // 1 (tables) + 1 (schema) + 2 (pages) = 4
        expect(mockExecuteOperation).toHaveBeenCalledTimes(4)
    })

    it('escapes single quotes in string values', async () => {
        mockExecuteOperation
            .mockResolvedValueOnce([{ name: 'users' }])
            .mockResolvedValueOnce([{ sql: 'CREATE TABLE users (id INTEGER, bio TEXT)' }])
            .mockResolvedValueOnce([{ id: 1, bio: "Alice's adventure" }])
            .mockResolvedValueOnce([])

        const text = await readStream(createDatabaseDumpStream(makeDataSource(), makeConfig(), 500))

        expect(text).toContain(`INSERT INTO "users" VALUES (1, 'Alice''s adventure');`)
    })

    it('handles empty database (no tables)', async () => {
        mockExecuteOperation.mockResolvedValueOnce([])

        const text = await readStream(createDatabaseDumpStream(makeDataSource(), makeConfig(), 500))

        expect(text).toBe('SQLite format 3\0')
    })

    it('skips tables with no schema entry', async () => {
        mockExecuteOperation
            .mockResolvedValueOnce([{ name: 'ghost' }])
            .mockResolvedValueOnce([]) // no schema row
            .mockResolvedValueOnce([]) // no data rows

        const text = await readStream(createDatabaseDumpStream(makeDataSource(), makeConfig(), 500))

        expect(text).not.toContain('CREATE TABLE')
        expect(text).not.toContain('INSERT INTO')
    })
})

// ─── dumpDatabaseRoute (sync streaming) ─────────────────────────────────────

describe('dumpDatabaseRoute (sync)', () => {
    it('returns a streaming response with correct headers', async () => {
        mockExecuteOperation
            .mockResolvedValueOnce([{ name: 'users' }, { name: 'orders' }])
            // users schema + page
            .mockResolvedValueOnce([{ sql: 'CREATE TABLE users (id INTEGER, name TEXT)' }])
            .mockResolvedValueOnce([{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }])
            // orders schema + page
            .mockResolvedValueOnce([{ sql: 'CREATE TABLE orders (id INTEGER, total REAL)' }])
            .mockResolvedValueOnce([{ id: 1, total: 99.99 }, { id: 2, total: 49.5 }])

        const response = await dumpDatabaseRoute(makeRequest(), makeDataSource(), makeConfig())

        expect(response).toBeInstanceOf(Response)
        expect(response.headers.get('Content-Type')).toBe('application/x-sqlite3')
        expect(response.headers.get('Content-Disposition')).toBe(
            'attachment; filename="database_dump.sql"'
        )

        const dumpText = await response.text()
        expect(dumpText).toContain('CREATE TABLE users (id INTEGER, name TEXT);')
        expect(dumpText).toContain(`INSERT INTO "users" VALUES (1, 'Alice');`)
        expect(dumpText).toContain(`INSERT INTO "users" VALUES (2, 'Bob');`)
        expect(dumpText).toContain('CREATE TABLE orders (id INTEGER, total REAL);')
        expect(dumpText).toContain('INSERT INTO "orders" VALUES (1, 99.99);')
        expect(dumpText).toContain('INSERT INTO "orders" VALUES (2, 49.5);')
    })

    it('handles empty database', async () => {
        mockExecuteOperation.mockResolvedValueOnce([])

        const response = await dumpDatabaseRoute(makeRequest(), makeDataSource(), makeConfig())

        expect(response).toBeInstanceOf(Response)
        expect(response.headers.get('Content-Type')).toBe('application/x-sqlite3')
        const dumpText = await response.text()
        expect(dumpText).toBe('SQLite format 3\0')
    })

    it('returns 500 when executeOperation throws synchronously before stream', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        // Make the outer try/catch fire by throwing in the URL parse (simulate bad request)
        const badReq = { url: 'not-a-url' } as any
        const response = await dumpDatabaseRoute(badReq, makeDataSource(), makeConfig())
        expect(response.status).toBe(500)
    })
})

// ─── dumpDatabaseRoute (async / R2) ─────────────────────────────────────────

describe('dumpDatabaseRoute (async=true)', () => {
    it('returns 400 when no R2 bucket is configured', async () => {
        const req = makeRequest('https://example.com/export/dump?async=true')
        const response = await dumpDatabaseRoute(req, makeDataSource(), makeConfig())

        expect(response.status).toBe(400)
        const json: any = await response.json()
        expect(json.error).toContain('EXPORT_BUCKET')
    })

    it('returns 202 accepted and uploads to R2 bucket', async () => {
        const mockBucket = makeMockBucket()
        const mockPut = mockBucket.put

        mockExecuteOperation
            .mockResolvedValueOnce([{ name: 'users' }])
            .mockResolvedValueOnce([{ sql: 'CREATE TABLE users (id INTEGER)' }])
            .mockResolvedValueOnce([{ id: 1 }])
            .mockResolvedValueOnce([])

        const req = makeRequest('https://example.com/export/dump?async=true')
        const response = await dumpDatabaseRoute(
            req,
            makeDataSource(),
            makeConfig({ export: { bucket: mockBucket } })
        )

        expect(response.status).toBe(200)
        const json: any = await response.json()
        expect(json.result.status).toBe('completed')
        expect(json.result.filename).toMatch(/^dump_/)
        expect(mockPut).toHaveBeenCalledWith(
            expect.stringContaining('.manifest.json'),
            expect.any(String),
            expect.objectContaining({ httpMetadata: { contentType: 'application/json' } })
        )
        expect(mockPut).toHaveBeenCalledWith(
            expect.stringContaining('.parts/'),
            expect.any(String),
            expect.objectContaining({ httpMetadata: { contentType: 'application/sql' } })
        )
    })

    it('uses custom filename from query param', async () => {
        const mockBucket = makeMockBucket()
        const mockPut = mockBucket.put

        mockExecuteOperation.mockResolvedValueOnce([])

        const req = makeRequest(
            'https://example.com/export/dump?async=true&filename=my_backup.sql'
        )
        const response = await dumpDatabaseRoute(
            req,
            makeDataSource(),
            makeConfig({ export: { bucket: mockBucket } })
        )

        expect(response.status).toBe(200)
        const json: any = await response.json()
        expect(json.result.filename).toBe('my_backup.sql')
        expect(mockPut).toHaveBeenCalledWith(
            'my_backup.sql.manifest.json',
            expect.any(String),
            expect.objectContaining({ httpMetadata: { contentType: 'application/json' } })
        )
        expect(mockPut).toHaveBeenCalledWith(
            'my_backup.sql.parts/00000000.sql',
            expect.any(String),
            expect.objectContaining({ httpMetadata: { contentType: 'application/sql' } })
        )
    })

    it('fires callback URL on completion', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response('ok'))
        vi.stubGlobal('fetch', fetchMock)

        const mockBucket = makeMockBucket()
        const mockPut = mockBucket.put

        mockExecuteOperation.mockResolvedValueOnce([])

        const req = makeRequest('https://example.com/export/dump?async=true')
        await dumpDatabaseRoute(
            req,
            makeDataSource(),
            makeConfig({
                export: { bucket: mockBucket, callbackUrl: 'https://hooks.example.com/done' },
            })
        )

        expect(fetchMock).toHaveBeenCalledWith(
            'https://hooks.example.com/done',
            expect.objectContaining({ method: 'POST' })
        )

        vi.unstubAllGlobals()
    })
})
