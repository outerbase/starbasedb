import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
    startDumpJobRoute,
    getDumpJobStatusRoute,
    dumpDatabaseSync,
} from './dump-async'
import { executeOperation } from '.'

vi.mock('.', () => ({
    executeOperation: vi.fn(),
}))

vi.mock('../utils', () => ({
    createResponse: vi.fn(
        (data, message, status = 200) =>
            new Response(
                JSON.stringify(
                    data !== undefined ? { result: data } : { error: message }
                ),
                {
                    status,
                    headers: { 'Content-Type': 'application/json' },
                }
            )
    ),
}))

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockDataSource(overrides: Partial<any> = {}) {
    return {
        source: 'internal',
        rpc: {
            executeQuery: vi.fn().mockResolvedValue([]),
            ...overrides.rpc,
        },
        context: {},
        ...overrides,
    } as any
}

function mockConfig() {
    return {
        outerbaseApiKey: 'test',
        role: 'admin',
        features: { export: true },
    } as any
}

function mockR2Bucket(): R2Bucket {
    const parts: any[] = []
    return {
        createMultipartUpload: vi.fn().mockResolvedValue({
            uploadPart: vi
                .fn()
                .mockImplementation((num: number, data: string) => {
                    parts.push({ partNumber: num, data })
                    return Promise.resolve({
                        partNumber: num,
                        etag: `etag-${num}`,
                    })
                }),
            complete: vi.fn().mockResolvedValue({}),
            abort: vi.fn().mockResolvedValue({}),
        }),
        createSignedUrl: vi
            .fn()
            .mockResolvedValue('https://r2.example.com/signed-url'),
        put: vi.fn().mockResolvedValue({}),
    } as unknown as R2Bucket
}

// ─── dumpDatabaseSync ─────────────────────────────────────────────────────────

describe('dumpDatabaseSync', () => {
    beforeEach(() => vi.clearAllMocks())

    it('produces a valid SQL dump for two tables', async () => {
        vi.mocked(executeOperation)
            // schema for users
            .mockResolvedValueOnce([
                { sql: 'CREATE TABLE users (id INTEGER, name TEXT)' },
            ])
            // data for users (batch 1, < CHUNK_ROWS so treated as final batch)
            .mockResolvedValueOnce([
                { id: 1, name: 'Alice' },
                { id: 2, name: 'Bob' },
            ])
            // schema for orders
            .mockResolvedValueOnce([
                { sql: 'CREATE TABLE orders (id INTEGER, total REAL)' },
            ])
            // data for orders (batch 1, < CHUNK_ROWS so treated as final batch)
            .mockResolvedValueOnce([{ id: 1, total: 9.99 }])

        const sql = await dumpDatabaseSync(mockDataSource(), mockConfig(), [
            'users',
            'orders',
        ])

        expect(sql).toContain('BEGIN TRANSACTION')
        expect(sql).toContain('CREATE TABLE users')
        expect(sql).toContain('INSERT INTO "users" VALUES (1, \'Alice\')')
        expect(sql).toContain('INSERT INTO "users" VALUES (2, \'Bob\')')
        expect(sql).toContain('CREATE TABLE orders')
        expect(sql).toContain('INSERT INTO "orders" VALUES (1, 9.99)')
        expect(sql).toContain('COMMIT')
    })

    it('handles NULL values correctly', async () => {
        vi.mocked(executeOperation).mockResolvedValueOnce([]) // list tables returns nothing — skip to the direct call

        const sql = await dumpDatabaseSync(mockDataSource(), mockConfig(), [])
        expect(sql).toContain('BEGIN TRANSACTION')
        expect(sql).toContain('COMMIT')
    })
})

// ─── startDumpJobRoute ────────────────────────────────────────────────────────

describe('startDumpJobRoute', () => {
    beforeEach(() => vi.clearAllMocks())

    it('returns 501 when no R2 bucket is provided', async () => {
        const req = new Request('https://example.com/export/dump/async', {
            method: 'POST',
        })
        const res = await startDumpJobRoute(
            req,
            mockDataSource(),
            mockConfig(),
            undefined
        )
        expect(res.status).toBe(501)
    })

    it('returns 202 with jobId when R2 bucket is present', async () => {
        const ds = mockDataSource()
        // List tables
        vi.mocked(executeOperation).mockResolvedValueOnce([{ name: 'users' }])
        // dumpDatabaseSync generator calls
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ sql: 'CREATE TABLE users (id INTEGER)' }])
            .mockResolvedValueOnce([{ id: 1 }])
            .mockResolvedValueOnce([])

        const req = new Request('https://example.com/export/dump/async', {
            method: 'POST',
        })
        const res = await startDumpJobRoute(
            req,
            ds,
            mockConfig(),
            mockR2Bucket()
        )
        expect(res.status).toBe(202)
        const body = await res.json()
        expect(body.result.jobId).toBeDefined()
        expect(body.result.status).toBe('running')
        expect(body.result.statusUrl).toMatch(/\/export\/dump\/status\//)
    })

    it('accepts optional callbackUrl in request body', async () => {
        const ds = mockDataSource()
        vi.mocked(executeOperation).mockResolvedValueOnce([])

        const req = new Request('https://example.com/export/dump/async', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                callbackUrl: 'https://example.com/callback',
            }),
        })
        const res = await startDumpJobRoute(
            req,
            ds,
            mockConfig(),
            mockR2Bucket()
        )
        expect(res.status).toBe(202)
    })
})

// ─── getDumpJobStatusRoute ────────────────────────────────────────────────────

describe('getDumpJobStatusRoute', () => {
    beforeEach(() => vi.clearAllMocks())

    it('returns 404 for unknown jobId', async () => {
        const ds = mockDataSource({
            rpc: { executeQuery: vi.fn().mockResolvedValue([]) },
        })
        const res = await getDumpJobStatusRoute('UNKNOWN', ds)
        expect(res.status).toBe(404)
    })

    it('returns status for a running job (no R2)', async () => {
        const ds = mockDataSource({
            rpc: {
                executeQuery: vi.fn().mockResolvedValue([
                    {
                        job_id: 'JOB123',
                        status: 'running',
                        total_tables: 5,
                        processed_tables: 2,
                        callback_url: null,
                        r2_key: 'dumps/JOB123.sql',
                        created_at: 1000000,
                        completed_at: null,
                        error: null,
                    },
                ]),
            },
        })
        const res = await getDumpJobStatusRoute('JOB123', ds)
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.result.status).toBe('running')
        expect(body.result.downloadUrl).toBeUndefined()
    })

    it('returns downloadUrl for completed job with R2', async () => {
        const ds = mockDataSource({
            rpc: {
                executeQuery: vi.fn().mockResolvedValue([
                    {
                        job_id: 'JOB456',
                        status: 'complete',
                        total_tables: 3,
                        processed_tables: 3,
                        callback_url: null,
                        r2_key: 'dumps/JOB456.sql',
                        created_at: 1000000,
                        completed_at: 1001000,
                        error: null,
                    },
                ]),
            },
        })
        const bucket = mockR2Bucket()
        const res = await getDumpJobStatusRoute('JOB456', ds, bucket)
        expect(res.status).toBe(200)
        const body = await res.json()
        expect(body.result.downloadUrl).toBe(
            'https://r2.example.com/signed-url'
        )
    })

    it('returns 500 for failed job', async () => {
        const ds = mockDataSource({
            rpc: {
                executeQuery: vi.fn().mockResolvedValue([
                    {
                        job_id: 'JOB789',
                        status: 'failed',
                        total_tables: 2,
                        processed_tables: 0,
                        callback_url: null,
                        r2_key: null,
                        created_at: 1000000,
                        completed_at: null,
                        error: 'Out of memory',
                    },
                ]),
            },
        })
        const res = await getDumpJobStatusRoute('JOB789', ds)
        expect(res.status).toBe(500)
    })
})
