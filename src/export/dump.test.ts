import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
    dumpDatabaseRoute,
    getDumpJobStatusRoute,
    downloadDumpJobRoute,
    processDumpJobSlice,
    formatDumpFilename,
    formatSqlValue,
    formatInsertStatement,
    shouldSkipTable,
    validateCallbackUrl,
    DUMP_JOBS_TABLE,
    DumpJobRecord,
    SQLITE_DUMP_HEADER,
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

/**
 * In-memory R2Bucket test double that faithfully enforces R2 multipart upload
 * semantics (createMultipartUpload, resumeMultipartUpload, uploadPart, complete,
 * abort, put/get/delete staging objects, and minimum non-final part size).
 */
class MockR2Bucket {
    public objects = new Map<string, Uint8Array>()
    public activeUploads = new Map<
        string,
        {
            key: string
            parts: Map<number, { etag: string; bytes: Uint8Array }>
            aborted: boolean
            completed: boolean
        }
    >()
    public completedPartSizes: number[] = []
    public abortCalls = 0
    private seq = 0

    private toUint8Array(value: any): Uint8Array {
        if (value instanceof Uint8Array) return new Uint8Array(value)
        if (value instanceof ArrayBuffer) return new Uint8Array(value)
        if (typeof value === 'string') return new TextEncoder().encode(value)
        throw new Error('Unsupported mock R2 payload type')
    }

    private makeUploadHandle(key: string, uploadId: string): R2MultipartUpload {
        return {
            key,
            uploadId,
            uploadPart: async (partNumber: number, value: any) => {
                const state = this.activeUploads.get(uploadId)
                if (!state || state.aborted || state.completed) {
                    throw new Error(`Upload ${uploadId} is not active`)
                }
                const bytes = this.toUint8Array(value)
                const etag = `etag-${uploadId}-${partNumber}`
                state.parts.set(partNumber, { etag, bytes })
                return { partNumber, etag }
            },
            complete: async (uploadedParts: R2UploadedPart[]) => {
                const state = this.activeUploads.get(uploadId)
                if (!state || state.aborted || state.completed) {
                    throw new Error(`Upload ${uploadId} cannot be completed`)
                }
                const ordered = [...uploadedParts].sort(
                    (a, b) => a.partNumber - b.partNumber
                )
                const chunks: Uint8Array[] = []
                let totalLen = 0
                this.completedPartSizes = []
                for (const p of ordered) {
                    const stored = state.parts.get(p.partNumber)
                    if (!stored || stored.etag !== p.etag) {
                        throw new Error(
                            `Missing or mismatched part ${p.partNumber}`
                        )
                    }
                    chunks.push(stored.bytes)
                    this.completedPartSizes.push(stored.bytes.byteLength)
                    totalLen += stored.bytes.byteLength
                }
                // Enforce official Cloudflare R2 multipart invariant:
                // All non-final parts MUST be identical in byte size, and final part <= non-final part size.
                if (this.completedPartSizes.length > 1) {
                    const partSize = this.completedPartSizes[0]
                    for (
                        let i = 0;
                        i < this.completedPartSizes.length - 1;
                        i++
                    ) {
                        if (this.completedPartSizes[i] !== partSize) {
                            throw new Error(
                                `R2 multipart violation: non-final part ${i + 1} size (${this.completedPartSizes[i]}) !== part 1 size (${partSize})`
                            )
                        }
                    }
                    const lastPartSize =
                        this.completedPartSizes[
                            this.completedPartSizes.length - 1
                        ]
                    if (lastPartSize > partSize) {
                        throw new Error(
                            `R2 multipart violation: final part size (${lastPartSize}) > non-final part size (${partSize})`
                        )
                    }
                }
                const full = new Uint8Array(totalLen)
                let offset = 0
                for (const c of chunks) {
                    full.set(c, offset)
                    offset += c.byteLength
                }
                this.objects.set(key, full)
                state.completed = true
                return { key, size: totalLen } as R2Object
            },
            abort: async () => {
                this.abortCalls++
                const state = this.activeUploads.get(uploadId)
                if (state) {
                    state.aborted = true
                }
            },
        } as unknown as R2MultipartUpload
    }

    async createMultipartUpload(key: string): Promise<R2MultipartUpload> {
        const uploadId = `upload-${++this.seq}`
        this.activeUploads.set(uploadId, {
            key,
            parts: new Map(),
            aborted: false,
            completed: false,
        })
        return this.makeUploadHandle(key, uploadId)
    }

    resumeMultipartUpload(key: string, uploadId: string): R2MultipartUpload {
        return this.makeUploadHandle(key, uploadId)
    }

    async put(key: string, value: any): Promise<R2Object> {
        const bytes = this.toUint8Array(value)
        this.objects.set(key, bytes)
        return { key, size: bytes.byteLength } as R2Object
    }

    async get(key: string): Promise<R2ObjectBody | null> {
        const bytes = this.objects.get(key)
        if (!bytes) return null
        const copy = new Uint8Array(bytes)
        return {
            key,
            size: copy.byteLength,
            body: new ReadableStream({
                start(controller) {
                    controller.enqueue(copy)
                    controller.close()
                },
            }),
            arrayBuffer: async () => copy.buffer,
            text: async () => new TextDecoder().decode(copy),
        } as unknown as R2ObjectBody
    }

    async delete(key: string): Promise<void> {
        this.objects.delete(key)
    }
}

/**
 * In-memory SQL dispatcher backed by fixture tables + `tmp_dump_jobs` store,
 * allowing realistic multi-table paginated queries and alarm resume verification.
 */
function createInMemorySqlHarness(fixture: {
    tables: Record<string, { schema: string; rows: Record<string, unknown>[] }>
}) {
    const jobs = new Map<string, DumpJobRecord>()

    const executeSql = async (
        sql: string,
        params: unknown[] = []
    ): Promise<Record<string, any>[]> => {
        const normalized = sql.replace(/\s+/g, ' ').trim()

        if (
            normalized.startsWith(
                `CREATE TABLE IF NOT EXISTS ${DUMP_JOBS_TABLE}`
            )
        ) {
            return []
        }
        if (
            normalized === "SELECT name FROM sqlite_master WHERE type='table';"
        ) {
            return [
                ...Object.keys(fixture.tables).map((name) => ({ name })),
                { name: 'sqlite_sequence' },
                { name: DUMP_JOBS_TABLE },
            ]
        }
        if (
            normalized ===
            "SELECT sql FROM sqlite_master WHERE type='table' AND name=?;"
        ) {
            const name = String(params[0])
            const tbl = fixture.tables[name]
            return tbl ? [{ sql: tbl.schema }] : []
        }
        const selectMatch = normalized.match(
            /^SELECT \* FROM "(.+)" LIMIT \? OFFSET \?;$/
        )
        if (selectMatch) {
            const tableName = selectMatch[1].replace(/""/g, '"')
            const limit = Number(params[0])
            const offset = Number(params[1])
            const tbl = fixture.tables[tableName]
            if (!tbl) throw new Error(`No such table: ${tableName}`)
            return tbl.rows.slice(offset, offset + limit)
        }
        if (
            normalized ===
            `SELECT id FROM ${DUMP_JOBS_TABLE} WHERE r2_key = ? LIMIT 1;`
        ) {
            const key = String(params[0])
            for (const j of jobs.values()) {
                if (j.r2_key === key) return [{ id: j.id }]
            }
            return []
        }
        if (normalized.startsWith(`INSERT INTO ${DUMP_JOBS_TABLE}`)) {
            const job: DumpJobRecord = {
                id: String(params[0]),
                status: params[1] as DumpJobRecord['status'],
                r2_key: String(params[2]),
                upload_id: (params[3] as string) ?? null,
                tables_json: String(params[4]),
                table_index: Number(params[5]),
                row_offset: Number(params[6]),
                schema_emitted: Number(params[7]),
                parts_json: String(params[8]),
                pending_buffer: String(params[9]),
                pending_staging_key: (params[10] as string) ?? null,
                chunk_size: Number(params[11]),
                work_budget_ms: Number(params[12]),
                breathing_interval_ms: Number(params[13]),
                rows_exported: Number(params[14]),
                bytes_written: Number(params[15]),
                callback_url: (params[16] as string) ?? null,
                callback_status: (params[17] as string) ?? null,
                error: (params[18] as string) ?? null,
                created_at: String(params[19]),
                updated_at: String(params[20]),
                completed_at: (params[21] as string) ?? null,
            }
            jobs.set(job.id, job)
            return []
        }
        if (normalized.startsWith(`UPDATE ${DUMP_JOBS_TABLE}`)) {
            const id = String(params[13])
            const existing = jobs.get(id)
            if (!existing) throw new Error(`Unknown dump job: ${id}`)
            jobs.set(id, {
                ...existing,
                status: params[0] as DumpJobRecord['status'],
                table_index: Number(params[1]),
                row_offset: Number(params[2]),
                schema_emitted: Number(params[3]),
                parts_json: String(params[4]),
                pending_buffer: String(params[5]),
                pending_staging_key: (params[6] as string) ?? null,
                rows_exported: Number(params[7]),
                bytes_written: Number(params[8]),
                callback_status: (params[9] as string) ?? null,
                error: (params[10] as string) ?? null,
                updated_at: String(params[11]),
                completed_at: (params[12] as string) ?? null,
            })
            return []
        }
        if (
            normalized ===
            `SELECT * FROM ${DUMP_JOBS_TABLE} WHERE id = ? LIMIT 1;`
        ) {
            const j = jobs.get(String(params[0]))
            return j ? [{ ...j }] : []
        }
        throw new Error(`Unhandled SQL in harness: ${normalized}`)
    }

    return { jobs, executeSql }
}

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
})

describe('Database Dump Helpers & SQL Edge Cases', () => {
    it('formats UTC timestamped R2 dump filenames cleanly', () => {
        const date = new Date('2024-01-01T17:00:00.000Z')
        expect(formatDumpFilename(date)).toBe('dump_20240101-170000.sql')
    })

    it('formats SQL values accurately for NULL, booleans, numbers, BLOBs, and objects', () => {
        expect(formatSqlValue(null)).toBe('NULL')
        expect(formatSqlValue(undefined)).toBe('NULL')
        expect(formatSqlValue(true)).toBe('1')
        expect(formatSqlValue(false)).toBe('0')
        expect(formatSqlValue(Number.NaN)).toBe('NULL')
        expect(formatSqlValue(Number.POSITIVE_INFINITY)).toBe('NULL')
        expect(formatSqlValue(42.5)).toBe('42.5')
        expect(formatSqlValue(9007199254740993n)).toBe('9007199254740993')
        expect(formatSqlValue(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))).toBe(
            "X'DEADBEEF'"
        )
        expect(formatSqlValue(new Uint8Array([0x01, 0x0a]).buffer)).toBe(
            "X'010A'"
        )
        expect(formatSqlValue({ k: "v'1" })).toBe('\'{"k":"v\'\'1"}\'')
    })

    it('quotes special table names while keeping plain identifiers clean', () => {
        expect(formatInsertStatement('users', { id: 1, name: null })).toBe(
            'INSERT INTO users VALUES (1, NULL);\n'
        )
        expect(
            formatInsertStatement('user events', { id: 2, active: true })
        ).toBe('INSERT INTO "user events" VALUES (2, 1);\n')
    })

    it('skips SQLite system tables and internal dump job tracking table', () => {
        expect(shouldSkipTable('sqlite_sequence')).toBe(true)
        expect(shouldSkipTable('sqlite_stat1')).toBe(true)
        expect(shouldSkipTable(DUMP_JOBS_TABLE)).toBe(true)
        expect(shouldSkipTable('users')).toBe(false)
    })

    it('validates callback URLs and rejects unsafe schemes', () => {
        expect(validateCallbackUrl('https://hooks.example.com/dump')).toBe(
            'https://hooks.example.com/dump'
        )
        expect(validateCallbackUrl('http://localhost:8787/hook')).toBe(
            'http://localhost:8787/hook'
        )
        expect(validateCallbackUrl('')).toBeUndefined()
        expect(() => validateCallbackUrl('javascript:alert(1)')).toThrow(
            /only http:\/\/ and https:\/\//
        )
        expect(() => validateCallbackUrl('not-a-url')).toThrow(
            /Invalid callback_url/
        )
    })

    it('returns 400 when request specifies an invalid callback_url', async () => {
        const req = new Request(
            'https://starbase.workers.dev/export/dump?callback_url=ftp://evil.example/cb'
        )
        const res = await dumpDatabaseRoute(mockDataSource, mockConfig, req)
        expect(res.status).toBe(400)
    })
})

describe('Large Database Resumable R2 Dumps & Breathing Intervals (#59)', () => {
    it('paginates multi-chunk tables accurately on synchronous fast path', async () => {
        const rows = Array.from({ length: 5 }, (_, i) => ({
            id: i + 1,
            name: `User_${i + 1}`,
            note: i === 2 ? null : `n'${i}`,
        }))
        const harness = createInMemorySqlHarness({
            tables: {
                users: {
                    schema: 'CREATE TABLE users (id INTEGER, name TEXT, note TEXT)',
                    rows,
                },
            },
        })
        vi.mocked(executeOperation).mockImplementation(async (queries) =>
            harness.executeSql(queries[0].sql, queries[0].params)
        )

        const res = await dumpDatabaseRoute(
            mockDataSource,
            mockConfig,
            undefined,
            {
                chunkSize: 2,
            }
        )
        expect(res.status).toBe(200)
        const sql = await res.text()
        expect(sql.startsWith(SQLITE_DUMP_HEADER)).toBe(true)
        expect(sql).not.toContain('sqlite_sequence')
        expect(sql).not.toContain(DUMP_JOBS_TABLE)
        expect(sql).toContain("INSERT INTO users VALUES (1, 'User_1', 'n''0');")
        expect(sql).toContain("INSERT INTO users VALUES (3, 'User_3', NULL);")
        expect(sql).toContain("INSERT INTO users VALUES (5, 'User_5', 'n''4');")
        expect(sql.match(/INSERT INTO users VALUES/g)?.length).toBe(5)
    })

    it('returns 503 when sync timeout is exceeded without an R2 DUMP_BUCKET binding', async () => {
        const rows = Array.from({ length: 6 }, (_, i) => ({ id: i + 1 }))
        const harness = createInMemorySqlHarness({
            tables: {
                big_table: {
                    schema: 'CREATE TABLE big_table (id INTEGER)',
                    rows,
                },
            },
        })

        let fakeClock = 1_704_128_400_000 // 2024-01-01T17:00:00Z
        vi.mocked(executeOperation).mockImplementation(async (queries) => {
            fakeClock += 12_000 // Simulate slow queries crossing 20s sync window
            return harness.executeSql(queries[0].sql, queries[0].params)
        })

        const res = await dumpDatabaseRoute(
            mockDataSource,
            mockConfig,
            undefined,
            {
                chunkSize: 2,
                syncTimeoutMs: 20_000,
                now: () => fakeClock,
            }
        )

        expect(res.status).toBe(503)
        const body = (await res.json()) as { error: string }
        expect(body.error).toContain('DUMP_BUCKET')
    })

    it('promotes slow dump to R2 multipart upload, resumes across DO breathing alarms, fires webhook, and produces byte-exact SQL', async () => {
        const usersRows = Array.from({ length: 7 }, (_, i) => ({
            id: i + 1,
            name: `User_${i + 1}`,
            payload: 'x'.repeat(200),
        }))
        const ordersRows = Array.from({ length: 6 }, (_, i) => ({
            id: i + 100,
            user_id: (i % 7) + 1,
            amount: (i + 1) * 12.5,
            raw: new Uint8Array([0xca, 0xfe, i]),
        }))

        const harness = createInMemorySqlHarness({
            tables: {
                users: {
                    schema: 'CREATE TABLE users (id INTEGER, name TEXT, payload TEXT)',
                    rows: usersRows,
                },
                orders: {
                    schema: 'CREATE TABLE orders (id INTEGER, user_id INTEGER, amount REAL, raw BLOB)',
                    rows: ordersRows,
                },
            },
        })

        // First produce ground-truth synchronous SQL to assert 100% byte-for-byte equivalence
        vi.mocked(executeOperation).mockImplementation(async (queries) =>
            harness.executeSql(queries[0].sql, queries[0].params)
        )
        const referenceRes = await dumpDatabaseRoute(
            mockDataSource,
            mockConfig,
            undefined,
            { chunkSize: 100 }
        )
        const expectedSql = await referenceRes.text()

        // Now run with a slow clock that triggers sync -> R2 promotion and multiple DO breathing slices
        const mockBucket = new MockR2Bucket()
        const scheduledAlarms: number[] = []
        const webhookCalls: { url: string; body: any; event: string | null }[] =
            []
        let webhookSawCompletedStatus = false

        const dsWithR2: DataSource = {
            ...mockDataSource,
            dumpBucket: mockBucket as unknown as R2Bucket,
            rpc: {
                executeQuery: vi.fn(),
                setAlarm: vi.fn(async (ts: number | Date) => {
                    scheduledAlarms.push(ts instanceof Date ? ts.getTime() : ts)
                }),
            } as any,
        }

        let fakeClock = Date.parse('2024-01-01T17:00:00.000Z')
        vi.mocked(executeOperation).mockImplementation(async (queries) => {
            if (queries[0].sql.startsWith('SELECT * FROM')) {
                fakeClock += 4_000 // Each batch simulates 4s of work
            }
            return harness.executeSql(queries[0].sql, queries[0].params)
        })

        const mockFetch = vi.fn(
            async (input: RequestInfo | URL, init?: RequestInit) => {
                const payload = JSON.parse(String(init?.body || '{}'))
                webhookCalls.push({
                    url: String(input),
                    body: payload,
                    event:
                        (init?.headers as Record<string, string>)?.[
                            'X-Starbase-Event'
                        ] ?? null,
                })
                // Verify status is ALREADY persisted as completed inside tmp_dump_jobs before callback fires
                const liveJob = harness.jobs.get(payload.jobId)
                webhookSawCompletedStatus = liveJob?.status === 'completed'
                return new Response('ok', { status: 200 })
            }
        ) as unknown as typeof fetch

        const req = new Request(
            'https://starbase.workers.dev/export/dump?callback_url=https://hooks.example.com/done&chunk_size=2&breathing_ms=5000&work_budget_ms=5000'
        )

        // Step 1: Initial HTTP call hits syncTimeoutMs=6000 after 2 batches -> promotes to R2 + DO alarm
        const initRes = await dumpDatabaseRoute(dsWithR2, mockConfig, req, {
            syncTimeoutMs: 6_000,
            workBudgetMs: 5_000,
            breathingIntervalMs: 5_000,
            minPartSizeBytes: 512, // Small threshold in test to exercise true multi-part R2 uploads
            now: () => fakeClock,
            fetchFn: mockFetch,
        })

        expect(initRes.status).toBe(202)
        const initJson = (await initRes.json()) as { result: any }
        expect(initJson.result.status).toBe('in_progress')
        expect(initJson.result.key).toMatch(/^dump_20240101-1700\d\d\.sql$/)
        expect(initJson.result.statusUrl).toBe(
            `/export/dump/${initJson.result.jobId}`
        )
        expect(scheduledAlarms.length).toBe(1)

        // Verify status route reports in_progress and download route returns 409 Conflict
        const statusRes1 = await getDumpJobStatusRoute(
            initJson.result.jobId,
            dsWithR2,
            mockConfig
        )
        expect(statusRes1.status).toBe(200)
        const statusBody1 = (await statusRes1.json()) as { result: any }
        expect(statusBody1.result.status).toBe('in_progress')

        const downloadEarly = await downloadDumpJobRoute(
            initJson.result.jobId,
            dsWithR2,
            mockConfig
        )
        expect(downloadEarly.status).toBe(409)

        // Step 2: Drive Durable Object alarm slices until completed (simulating breathing pauses)
        let alarmTicks = 0
        let latestJob = harness.jobs.get(initJson.result.jobId)!
        while (latestJob.status === 'in_progress') {
            alarmTicks++
            expect(alarmTicks).toBeLessThan(20)
            fakeClock += latestJob.breathing_interval_ms // Breathing rest window
            latestJob = await processDumpJobSlice({
                job: latestJob,
                executeSql: async (sql, params) => {
                    if (sql.startsWith('SELECT * FROM')) {
                        fakeClock += 3_000 // 2 batches = 6s > 5s work budget -> pauses cleanly
                    }
                    return harness.executeSql(sql, params)
                },
                bucket: mockBucket as unknown as R2Bucket,
                scheduleAlarm: async (ts) => {
                    scheduledAlarms.push(ts)
                },
                minPartSizeBytes: 512,
                now: () => fakeClock,
                fetchFn: mockFetch,
            })
        }

        // Must have required multiple DO alarm slices with breathing intervals
        expect(alarmTicks).toBeGreaterThanOrEqual(2)
        expect(scheduledAlarms.length).toBeGreaterThanOrEqual(2)
        expect(latestJob.status).toBe('completed')
        expect(latestJob.rows_exported).toBe(
            usersRows.length + ordersRows.length
        )
        expect(latestJob.callback_status).toBe('delivered')
        expect(webhookCalls.length).toBe(1)
        expect(webhookCalls[0].event).toBe('export.dump.completed')
        expect(webhookSawCompletedStatus).toBe(true)

        // Verify multiple R2 parts were uploaded with STRICT Cloudflare R2 equal non-final part sizes
        expect(mockBucket.completedPartSizes.length).toBeGreaterThanOrEqual(3)
        for (let i = 0; i < mockBucket.completedPartSizes.length - 1; i++) {
            expect(mockBucket.completedPartSizes[i]).toBe(512)
        }
        expect(
            mockBucket.completedPartSizes[
                mockBucket.completedPartSizes.length - 1
            ]
        ).toBeLessThanOrEqual(512)

        // Verify schema never contains double semicolons ;;
        expect(expectedSql).not.toContain(';;')

        // Verify no leftover staging key remains in R2
        expect(mockBucket.objects.has(`${latestJob.r2_key}.pending`)).toBe(
            false
        )

        // Step 3: Download completed dump via download route and verify 100% byte-for-byte match!
        const downloadDone = await downloadDumpJobRoute(
            initJson.result.jobId,
            dsWithR2,
            mockConfig
        )
        expect(downloadDone.status).toBe(200)
        expect(downloadDone.headers.get('Content-Type')).toBe(
            'application/x-sqlite3'
        )
        expect(downloadDone.headers.get('Content-Disposition')).toBe(
            `attachment; filename="${latestJob.r2_key}"`
        )
        const streamedSql = await downloadDone.text()
        expect(streamedSql).toBe(expectedSql)
    })

    it('spills pending tails > 64 KiB to R2 staging across alarm pauses and cleans them up on completion', async () => {
        // Construct rows totaling ~80 KiB (< 5 MiB R2 part threshold, > 64 KiB inline threshold)
        const bigRows = Array.from({ length: 10 }, (_, i) => ({
            id: i + 1,
            blob_text: 'A'.repeat(10_000),
        }))
        const harness = createInMemorySqlHarness({
            tables: {
                large_blobs: {
                    schema: 'CREATE TABLE large_blobs (id INTEGER, blob_text TEXT)',
                    rows: bigRows,
                },
            },
        })
        const mockBucket = new MockR2Bucket()
        const dsWithR2: DataSource = {
            ...mockDataSource,
            dumpBucket: mockBucket as unknown as R2Bucket,
            rpc: { executeQuery: vi.fn(), setAlarm: vi.fn() } as any,
        }

        let fakeClock = Date.parse('2024-06-15T12:30:00.000Z')
        vi.mocked(executeOperation).mockImplementation(async (queries) => {
            if (queries[0].sql.startsWith('SELECT * FROM')) {
                fakeClock += 6_000 // Exceeds 5s work budget after 1 batch of 8 rows (~80 KiB)
            }
            return harness.executeSql(queries[0].sql, queries[0].params)
        })

        const req = new Request(
            'https://starbase.workers.dev/export/dump?async=true&chunk_size=8&work_budget_ms=5000'
        )
        const res = await dumpDatabaseRoute(dsWithR2, mockConfig, req, {
            minPartSizeBytes: 5 * 1024 * 1024, // Full 5 MiB R2 part size!
            now: () => fakeClock,
        })
        expect(res.status).toBe(202)
        const { result } = (await res.json()) as { result: any }
        expect(result.status).toBe('in_progress')

        // Check that > 64 KiB tail spilled to R2 staging instead of bloating DO SQLite row
        const pausedJob = harness.jobs.get(result.jobId)!
        expect(pausedJob.pending_buffer).toBe('')
        expect(pausedJob.pending_staging_key).toBe(
            `${pausedJob.r2_key}.pending`
        )
        expect(mockBucket.objects.has(`${pausedJob.r2_key}.pending`)).toBe(true)

        // Resume final slice
        const doneJob = await processDumpJobSlice({
            job: pausedJob,
            executeSql: harness.executeSql,
            bucket: mockBucket as unknown as R2Bucket,
            minPartSizeBytes: 5 * 1024 * 1024,
            now: () => fakeClock + 5_000,
        })
        expect(doneJob.status).toBe('completed')
        expect(doneJob.rows_exported).toBe(10)
        // Staging key must be deleted after completion
        expect(mockBucket.objects.has(`${doneJob.r2_key}.pending`)).toBe(false)

        const downloaded = await (
            await downloadDumpJobRoute(result.jobId, dsWithR2, mockConfig)
        ).text()
        expect(downloaded.startsWith(SQLITE_DUMP_HEADER)).toBe(true)
        expect(
            downloaded.match(/INSERT INTO large_blobs VALUES/g)?.length
        ).toBe(10)
    })

    it('aborts R2 multipart upload and notifies callback when a mid-dump failure occurs', async () => {
        const harness = createInMemorySqlHarness({
            tables: {
                users: {
                    schema: 'CREATE TABLE users (id INTEGER)',
                    rows: [{ id: 1 }, { id: 2 }, { id: 3 }],
                },
            },
        })
        const mockBucket = new MockR2Bucket()
        const upload = await mockBucket.createMultipartUpload(
            'dump_20240101-170000.sql'
        )
        const job: DumpJobRecord = {
            id: 'job-fail-1',
            status: 'in_progress',
            r2_key: 'dump_20240101-170000.sql',
            upload_id: upload.uploadId,
            tables_json: JSON.stringify(['users']),
            table_index: 0,
            row_offset: 0,
            schema_emitted: 0,
            parts_json: '[]',
            pending_buffer: '',
            pending_staging_key: 'dump_20240101-170000.sql.pending', // Missing in R2 -> fail loud!
            chunk_size: 2,
            work_budget_ms: 5000,
            breathing_interval_ms: 5000,
            rows_exported: 0,
            bytes_written: 0,
            callback_url: 'https://hooks.example.com/fail',
            callback_status: null,
            error: null,
            created_at: '2024-01-01T17:00:00.000Z',
            updated_at: '2024-01-01T17:00:00.000Z',
            completed_at: null,
        }
        harness.jobs.set(job.id, job)

        const consoleErrorSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})
        const failWebhook = vi.fn(
            async () => new Response('accepted', { status: 202 })
        ) as unknown as typeof fetch

        const failed = await processDumpJobSlice({
            job,
            executeSql: harness.executeSql,
            bucket: mockBucket as unknown as R2Bucket,
            fetchFn: failWebhook,
        })

        expect(failed.status).toBe('failed')
        expect(failed.error).toContain('Missing R2 dump staging buffer')
        expect(failed.callback_status).toBe('delivered')
        expect(failWebhook).toHaveBeenCalledTimes(1)
        expect(mockBucket.abortCalls).toBe(1)
        expect(mockBucket.activeUploads.get(upload.uploadId)?.aborted).toBe(
            true
        )
        consoleErrorSpy.mockRestore()
    })

    it('returns 404 for unknown dump job IDs on status and download routes', async () => {
        const harness = createInMemorySqlHarness({ tables: {} })
        vi.mocked(executeOperation).mockImplementation(async (queries) =>
            harness.executeSql(queries[0].sql, queries[0].params)
        )
        const dsWithR2: DataSource = {
            ...mockDataSource,
            dumpBucket: new MockR2Bucket() as unknown as R2Bucket,
        }

        const statusRes = await getDumpJobStatusRoute(
            'non-existent',
            dsWithR2,
            mockConfig
        )
        expect(statusRes.status).toBe(404)

        const downloadRes = await downloadDumpJobRoute(
            'non-existent',
            dsWithR2,
            mockConfig
        )
        expect(downloadRes.status).toBe(404)
    })

    it('returns 400 when async=true is requested without an R2 DUMP_BUCKET binding', async () => {
        const harness = createInMemorySqlHarness({ tables: {} })
        vi.mocked(executeOperation).mockImplementation(async (queries) =>
            harness.executeSql(queries[0].sql, queries[0].params)
        )
        const req = new Request(
            'https://starbase.workers.dev/export/dump?async=true'
        )
        const res = await dumpDatabaseRoute(mockDataSource, mockConfig, req)
        expect(res.status).toBe(400)
        const body = (await res.json()) as { error: string }
        expect(body.error).toContain('DUMP_BUCKET')
    })

    it('generates collision-safe R2 dump keys when two dumps start in the same second and fires sync callback when fast', async () => {
        const harness = createInMemorySqlHarness({
            tables: {
                items: {
                    schema: 'CREATE TABLE items (id INTEGER, label TEXT)',
                    rows: [{ id: 1, label: 'alpha' }],
                },
            },
        })
        vi.mocked(executeOperation).mockImplementation(async (queries) =>
            harness.executeSql(queries[0].sql, queries[0].params)
        )

        const mockBucket = new MockR2Bucket()
        const syncCallbacks: any[] = []
        const mockFetch = vi.fn(async (_url: any, init?: RequestInit) => {
            syncCallbacks.push(JSON.parse(String(init?.body || '{}')))
            return new Response('ok', { status: 200 })
        }) as unknown as typeof fetch

        const fixedNow = Date.parse('2024-01-01T17:00:00.000Z')
        const dsWithR2: DataSource = {
            ...mockDataSource,
            dumpBucket: mockBucket as unknown as R2Bucket,
            rpc: { executeQuery: vi.fn(), setAlarm: vi.fn() } as any,
        }

        // 1. Two async jobs at identical timestamp must get distinct R2 keys
        const reqAsync = new Request(
            'https://starbase.workers.dev/export/dump?async=true'
        )
        const r1 = await dumpDatabaseRoute(dsWithR2, mockConfig, reqAsync, {
            now: () => fixedNow,
        })
        const r2 = await dumpDatabaseRoute(dsWithR2, mockConfig, reqAsync, {
            now: () => fixedNow,
        })
        const j1 = (await r1.json()) as { result: any }
        const j2 = (await r2.json()) as { result: any }
        expect(j1.result.key).toBe('dump_20240101-170000.sql')
        expect(j2.result.key).toMatch(
            /^dump_20240101-170000_[a-zA-Z0-9]{8}\.sql$/
        )
        expect(j1.result.key).not.toBe(j2.result.key)

        // 2. Synchronous fast dump with callback_url delivers export.dump.completed webhook
        const reqSyncCb = new Request(
            'https://starbase.workers.dev/export/dump?callback_url=https://hooks.example.com/sync'
        )
        const rSync = await dumpDatabaseRoute(dsWithR2, mockConfig, reqSyncCb, {
            now: () => fixedNow,
            fetchFn: mockFetch,
        })
        expect(rSync.status).toBe(200)
        expect(syncCallbacks.length).toBe(1)
        expect(syncCallbacks[0].mode).toBe('sync')
        expect(syncCallbacks[0].rowsExported).toBe(1)
    })
})
