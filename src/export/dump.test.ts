import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
    dumpDatabaseRoute,
    getDumpJobStatusRoute,
    downloadDumpJobRoute,
    processDumpJobSlice,
    R2MultipartDumpWriter,
    formatDumpFilename,
    formatSqlValue,
    formatInsertStatement,
    shouldSkipTable,
    validateCallbackUrl,
    DUMP_JOBS_TABLE,
    ALARM_SLOTS_TABLE,
    DumpJobRecord,
    SQLITE_DUMP_HEADER,
} from './dump'
import { executeOperation } from '.'
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
 * In-memory R2Bucket test double that enforces Cloudflare R2's exact equal
 * non-final multipart part-size invariant, staging put/get/delete, and abort.
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
                if (this.completedPartSizes.length > 1) {
                    const partSize = this.completedPartSizes[0]
                    for (
                        let i = 0;
                        i < this.completedPartSizes.length - 1;
                        i++
                    ) {
                        if (this.completedPartSizes[i] !== partSize) {
                            throw new Error(
                                `R2 multipart violation: non-final part ${i + 1} (${this.completedPartSizes[i]}) !== part 1 (${partSize})`
                            )
                        }
                    }
                    const last =
                        this.completedPartSizes[
                            this.completedPartSizes.length - 1
                        ]
                    if (last > partSize) {
                        throw new Error(
                            `R2 multipart violation: final part (${last}) > part 1 (${partSize})`
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
                if (state) state.aborted = true
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
 * In-memory SQL dispatcher supporting rowid keyset pagination, WITHOUT ROWID
 * OFFSET fallback, UNIQUE(r2_key) enforcement, and dynamic `saveJob` writes.
 */
function createInMemorySqlHarness(fixture: {
    tables: Record<
        string,
        {
            schema: string
            rows: { rowid: number | bigint; data: Record<string, unknown> }[]
        }
    >
}) {
    const jobs = new Map<string, DumpJobRecord>()

    const executeSql = async (
        sql: string,
        params: unknown[] = []
    ): Promise<Record<string, any>[]> => {
        const norm = sql.replace(/\s+/g, ' ').trim()

        if (norm === "SELECT name FROM sqlite_master WHERE type='table';") {
            return [
                ...Object.keys(fixture.tables).map((name) => ({ name })),
                { name: 'sqlite_sequence' },
                { name: '_cf_KV' },
                { name: 'tmp_cache' },
                { name: 'tmp_query_log' },
                { name: 'tmp_cron_tasks' },
                { name: DUMP_JOBS_TABLE },
                { name: ALARM_SLOTS_TABLE },
            ]
        }

        if (
            norm ===
            "SELECT sql FROM sqlite_master WHERE type='table' AND name=?;"
        ) {
            const tbl = fixture.tables[String(params[0])]
            return tbl ? [{ sql: tbl.schema }] : []
        }

        const rawTrim = sql.trim()

        // Keyset pagination: SELECT CAST(_rowid_ AS TEXT) AS __sb_rid[_*], * FROM "t" [WHERE _rowid_ > N] ORDER BY _rowid_ ASC LIMIT M;
        const keysetMatch = rawTrim.match(
            /^SELECT CAST\(_rowid_ AS TEXT\) AS (__sb_rid_*), \* FROM "([\s\S]+)"(?: WHERE _rowid_ > (-?\d+))? ORDER BY _rowid_ ASC LIMIT (\d+);$/
        )
        if (keysetMatch) {
            const alias = keysetMatch[1]
            const tableName = keysetMatch[2].replace(/""/g, '"')
            const afterRowId =
                keysetMatch[3] !== undefined ? BigInt(keysetMatch[3]) : null
            const limit = Number(keysetMatch[4])
            const tbl = fixture.tables[tableName]
            if (!tbl) throw new Error(`No such table: ${tableName}`)
            if (/\bWITHOUT\s+ROWID\b/i.test(tbl.schema)) {
                throw new Error('no such column: _rowid_')
            }
            const filtered = tbl.rows
                .filter(
                    (r) => afterRowId === null || BigInt(r.rowid) > afterRowId
                )
                .sort((a, b) =>
                    BigInt(a.rowid) < BigInt(b.rowid)
                        ? -1
                        : BigInt(a.rowid) > BigInt(b.rowid)
                          ? 1
                          : 0
                )
                .slice(0, limit)
            return filtered.map((r) => ({
                [alias]: String(r.rowid),
                ...r.data,
            }))
        }

        // OFFSET fallback: SELECT * FROM "t" LIMIT M OFFSET O;
        const offsetMatch = rawTrim.match(
            /^SELECT \* FROM "([\s\S]+)" LIMIT (\d+) OFFSET (\d+);$/
        )
        if (offsetMatch) {
            const tableName = offsetMatch[1].replace(/""/g, '"')
            const limit = Number(offsetMatch[2])
            const offset = Number(offsetMatch[3])
            const tbl = fixture.tables[tableName]
            if (!tbl) throw new Error(`No such table: ${tableName}`)
            return tbl.rows
                .slice(offset, offset + limit)
                .map((r) => ({ ...r.data }))
        }

        // Generic INSERT / INSERT OR REPLACE INTO tmp_dump_jobs (cols) VALUES (...)
        const insertMatch = norm.match(
            /^INSERT (OR REPLACE )?INTO tmp_dump_jobs \(([^)]+)\) VALUES \(([^)]+)\);$/
        )
        if (insertMatch) {
            const isReplace = Boolean(insertMatch[1])
            const cols = insertMatch[2].split(',').map((c) => c.trim())
            const rec: Record<string, any> = {}
            cols.forEach((col, i) => {
                rec[col] = params[i] ?? null
            })
            if (!isReplace) {
                for (const existing of jobs.values()) {
                    if (existing.r2_key === rec.r2_key) {
                        throw new Error(
                            'UNIQUE constraint failed: tmp_dump_jobs.r2_key'
                        )
                    }
                }
            }
            jobs.set(String(rec.id), rec as DumpJobRecord)
            return []
        }

        if (norm === `DELETE FROM ${DUMP_JOBS_TABLE} WHERE id = ?;`) {
            jobs.delete(String(params[0]))
            return []
        }

        if (norm === `SELECT * FROM ${DUMP_JOBS_TABLE} WHERE id = ? LIMIT 1;`) {
            const j = jobs.get(String(params[0]))
            return j ? [{ ...j }] : []
        }

        throw new Error(`Unhandled SQL in harness: ${norm}`)
    }

    return { jobs, executeSql }
}

function makeRows(rows: Record<string, unknown>[]) {
    return rows.map((data, idx) => ({ rowid: idx + 1, data }))
}

let mockDataSource: DataSource
let mockConfig: StarbaseDBConfiguration

beforeEach(() => {
    vi.clearAllMocks()

    mockDataSource = {
        source: 'external',
        external: { dialect: 'sqlite' },
        rpc: {
            executeQuery: vi.fn(),
            setAlarm: vi.fn(),
            scheduleDumpAlarm: vi.fn(),
        },
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
        expect(dumpText).not.toContain(';;')
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
        expect(formatDumpFilename(new Date('2024-01-01T17:00:00.000Z'))).toBe(
            'dump_20240101-170000.sql'
        )
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

    it('quotes reserved SQLite keywords, special table names, and numeric column names cleanly', () => {
        expect(formatInsertStatement('users', { id: 1, name: null })).toBe(
            'INSERT INTO users VALUES (1, NULL);\n'
        )
        expect(formatInsertStatement('order', { v: 'safe' })).toBe(
            'INSERT INTO "order" VALUES (\'safe\');\n'
        )
        expect(formatInsertStatement('group', { id: 1 })).toBe(
            'INSERT INTO "group" VALUES (1);\n'
        )
        expect(
            formatInsertStatement('user events', { id: 2, active: true })
        ).toBe('INSERT INTO "user events" VALUES (2, 1);\n')
        // JS puts integer-index key "1" before "a" -> explicit column list prevents swapped values
        expect(
            formatInsertStatement('numbered', { a: 'first', '1': 'second' })
        ).toBe(
            'INSERT INTO numbered ("1", "a") VALUES (\'second\', \'first\');\n'
        )
    })

    it('skips sqlite_*, _cf_*, and StarbaseDB internal tables while preserving user tmp_* tables', () => {
        expect(shouldSkipTable('sqlite_sequence')).toBe(true)
        expect(shouldSkipTable('_cf_KV')).toBe(true)
        expect(shouldSkipTable('tmp_query_log')).toBe(true)
        expect(shouldSkipTable('tmp_cache')).toBe(true)
        expect(shouldSkipTable('tmp_rls_policies')).toBe(true)
        expect(shouldSkipTable('tmp_cron_tasks')).toBe(true)
        expect(shouldSkipTable(DUMP_JOBS_TABLE)).toBe(true)
        expect(shouldSkipTable(ALARM_SLOTS_TABLE)).toBe(true)
        expect(shouldSkipTable('tmp_user_staging')).toBe(false)
        expect(shouldSkipTable('users')).toBe(false)
    })

    it('sanitizes newlines in table names inside SQL header comments', async () => {
        const evilName = 'x\nDROP TABLE users;'
        const harness = createInMemorySqlHarness({
            tables: {
                [evilName]: {
                    schema: `CREATE TABLE "${evilName}" (id INTEGER)`,
                    rows: makeRows([{ id: 1 }]),
                },
            },
        })
        vi.mocked(executeOperation).mockImplementation(async (q) =>
            harness.executeSql(q[0].sql, q[0].params)
        )
        const res = await dumpDatabaseRoute(mockDataSource, mockConfig)
        const sql = await res.text()
        expect(sql).toContain('-- Table: x DROP TABLE users;\n')
        expect(sql).not.toContain('\nDROP TABLE users;\n')
    })

    it('validates callback URLs and rejects unsafe schemes with 400', async () => {
        expect(validateCallbackUrl('https://hooks.example.com/dump')).toBe(
            'https://hooks.example.com/dump'
        )
        expect(validateCallbackUrl('')).toBeUndefined()
        expect(() => validateCallbackUrl('javascript:alert(1)')).toThrow(
            /only http:\/\/ and https:\/\//
        )
        const req = new Request(
            'https://starbase.workers.dev/export/dump?callback_url=ftp://evil.example/cb'
        )
        const res = await dumpDatabaseRoute(mockDataSource, mockConfig, req)
        expect(res.status).toBe(400)
    })
})

describe('Security, Pagination & Streaming Fallback (#59)', () => {
    it('enforces admin-only access (403) on ?async=true, status, and download routes while keeping client sync streaming', async () => {
        const clientConfig: StarbaseDBConfiguration = {
            ...mockConfig,
            role: 'client',
        }
        const dsWithR2: DataSource = {
            ...mockDataSource,
            dumpBucket: new MockR2Bucket() as unknown as R2Bucket,
        }

        const asyncRes = await dumpDatabaseRoute(
            dsWithR2,
            clientConfig,
            new Request('https://starbase.workers.dev/export/dump?async=true')
        )
        expect(asyncRes.status).toBe(403)

        const statusRes = await getDumpJobStatusRoute(
            'job-1',
            dsWithR2,
            clientConfig
        )
        expect(statusRes.status).toBe(403)

        const dlRes = await downloadDumpJobRoute(
            'job-1',
            dsWithR2,
            clientConfig
        )
        expect(dlRes.status).toBe(403)

        // Client-role sync dump stays on ReadableStream path (never bypasses RLS via DO alarm)
        const harness = createInMemorySqlHarness({
            tables: {
                notes: {
                    schema: 'CREATE TABLE notes (id INTEGER, body TEXT)',
                    rows: makeRows([{ id: 1, body: 'owned' }]),
                },
            },
        })
        vi.mocked(executeOperation).mockImplementation(async (q) =>
            harness.executeSql(q[0].sql, q[0].params)
        )
        const clientSync = await dumpDatabaseRoute(
            dsWithR2,
            clientConfig,
            undefined,
            { maxSyncBytes: 1 } // Even with tiny byte cap, non-admin stays on streaming sync (no R2 bypass!)
        )
        expect(clientSync.status).toBe(200)
        expect(await clientSync.text()).toContain(
            "INSERT INTO notes VALUES (1, 'owned');"
        )
    })

    it('streams paginated dumps via ReadableStream without R2 and uses keyset rowid immune to concurrent deletes', async () => {
        const tableRows = makeRows([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }])
        const harness = createInMemorySqlHarness({
            tables: {
                t: {
                    schema: 'CREATE TABLE t (id INTEGER PRIMARY KEY)',
                    rows: tableRows,
                },
                kv: {
                    schema: 'CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID',
                    rows: makeRows([
                        { k: 'a', v: '1' },
                        { k: 'b', v: '2' },
                        { k: 'c', v: '3' },
                    ]),
                },
            },
        })
        let deletedAfterFirstPage = false
        vi.mocked(executeOperation).mockImplementation(async (q) => {
            const res = await harness.executeSql(q[0].sql, q[0].params)
            if (
                !deletedAfterFirstPage &&
                q[0].sql.includes('FROM "t"') &&
                !q[0].sql.includes('WHERE _rowid_ >')
            ) {
                deletedAfterFirstPage = true
                // Concurrent delete of rowid 1 while export is mid-table: keyset MUST still export id 3 and 4!
                tableRows.shift()
            }
            return res
        })

        // No dumpBucket bound -> streams cleanly via ReadableStream without 503
        const res = await dumpDatabaseRoute(
            mockDataSource,
            mockConfig,
            undefined,
            { chunkSize: 2 }
        )
        expect(res.status).toBe(200)
        const sql = await res.text()
        expect(sql.startsWith(SQLITE_DUMP_HEADER)).toBe(true)
        expect(sql).toContain('INSERT INTO t VALUES (1);')
        expect(sql).toContain('INSERT INTO t VALUES (2);')
        expect(sql).toContain('INSERT INTO t VALUES (3);')
        expect(sql).toContain('INSERT INTO t VALUES (4);')
        // WITHOUT ROWID table fell back cleanly to OFFSET pagination
        expect(sql).toContain("INSERT INTO kv VALUES ('a', '1');")
        expect(sql).toContain("INSERT INTO kv VALUES ('c', '3');")
        // Stock internal tables excluded
        expect(sql).not.toContain('tmp_query_log')
        expect(sql).not.toContain('_cf_KV')
        expect(sql).not.toContain('sqlite_sequence')
    })

    it('enforces maxSyncBytes after appending the final short page (no oversized 200 bypass)', async () => {
        const harness = createInMemorySqlHarness({
            tables: {
                wide: {
                    schema: 'CREATE TABLE wide (x TEXT)',
                    rows: makeRows([{ x: 'a'.repeat(500) }]),
                },
            },
        })
        vi.mocked(executeOperation).mockImplementation(async (q) =>
            harness.executeSql(q[0].sql, q[0].params)
        )
        const mockBucket = new MockR2Bucket()
        const dsWithR2: DataSource = {
            ...mockDataSource,
            dumpBucket: mockBucket as unknown as R2Bucket,
        }
        const res = await dumpDatabaseRoute(dsWithR2, mockConfig, undefined, {
            maxSyncBytes: 120,
            minPartSizeBytes: 64,
        })
        expect(res.status).toBe(202)
        const { result } = (await res.json()) as { result: any }
        expect(result.status).toBe('in_progress')
        expect(mockDataSource.rpc.scheduleDumpAlarm).toHaveBeenCalledTimes(1)
    })
})

describe('Resumable R2 Multipart Dumps, Concurrency & Crash Safety (#59)', () => {
    it('promotes slow dump to R2, resumes across DO breathing alarms, enforces exact part sizes, hides callbackUrl, and matches sync SQL byte-for-byte', async () => {
        const usersRows = makeRows(
            Array.from({ length: 7 }, (_, i) => ({
                id: i + 1,
                name: `User_${i + 1}`,
                payload: 'x'.repeat(200),
            }))
        )
        const ordersRows = makeRows(
            Array.from({ length: 6 }, (_, i) => ({
                id: i + 100,
                user_id: (i % 7) + 1,
                amount: (i + 1) * 12.5,
                raw: new Uint8Array([0xca, 0xfe, i]),
            }))
        )

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

        // Ground-truth single-pass streaming dump for byte-exact comparison
        vi.mocked(executeOperation).mockImplementation(async (q) =>
            harness.executeSql(q[0].sql, q[0].params)
        )
        const expectedSql = await (
            await dumpDatabaseRoute(mockDataSource, mockConfig, undefined, {
                chunkSize: 100,
            })
        ).text()

        const mockBucket = new MockR2Bucket()
        const scheduledAlarms: number[] = []
        const webhookCalls: { url: string; body: any; event: string | null }[] =
            []
        let webhookSawCompleted = false
        let webhookHadSignal = false

        const dsWithR2: DataSource = {
            ...mockDataSource,
            dumpBucket: mockBucket as unknown as R2Bucket,
            rpc: {
                executeQuery: vi.fn(),
                setAlarm: vi.fn(),
                scheduleDumpAlarm: vi.fn(async (ts: number | Date) => {
                    scheduledAlarms.push(ts instanceof Date ? ts.getTime() : ts)
                }),
            } as any,
        }

        let fakeClock = Date.parse('2024-01-01T17:00:00.000Z')
        vi.mocked(executeOperation).mockImplementation(async (q) => {
            if (q[0].sql.startsWith('SELECT CAST(_rowid_')) fakeClock += 4_000
            return harness.executeSql(q[0].sql, q[0].params)
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
                webhookHadSignal = init?.signal instanceof AbortSignal
                webhookSawCompleted =
                    harness.jobs.get(payload.jobId)?.status === 'completed'
                return new Response('ok', { status: 200 })
            }
        ) as unknown as typeof fetch

        const req = new Request(
            'https://starbase.workers.dev/export/dump?callback_url=https://hooks.example.com/secret-token&chunk_size=2&breathing_ms=5000&work_budget_ms=5000'
        )
        const initRes = await dumpDatabaseRoute(dsWithR2, mockConfig, req, {
            syncTimeoutMs: 6_000,
            workBudgetMs: 5_000,
            breathingIntervalMs: 5_000,
            minPartSizeBytes: 512,
            now: () => fakeClock,
            fetchFn: mockFetch,
        })

        expect(initRes.status).toBe(202)
        const initJson = (await initRes.json()) as { result: any }
        expect(initJson.result.status).toBe('in_progress')
        expect(initJson.result.key).toMatch(/^dump_20240101-1700\d\d\.sql$/)
        // Secret webhook URL MUST NOT be exposed in public summary
        expect(initJson.result.callbackUrl).toBeUndefined()
        expect(scheduledAlarms.length).toBe(1)

        // Status returns 200 without leaking callbackUrl; download returns 409 while in_progress
        const statusRes = await getDumpJobStatusRoute(
            initJson.result.jobId,
            dsWithR2,
            mockConfig
        )
        expect(statusRes.status).toBe(200)
        expect(
            ((await statusRes.json()) as { result: any }).result.callbackUrl
        ).toBeUndefined()

        const earlyDl = await downloadDumpJobRoute(
            initJson.result.jobId,
            dsWithR2,
            mockConfig
        )
        expect(earlyDl.status).toBe(409)

        // Drive DO alarm slices with breathing pauses until completed
        let alarmTicks = 0
        let latestJob = harness.jobs.get(initJson.result.jobId)!
        while (latestJob.status === 'in_progress') {
            alarmTicks++
            expect(alarmTicks).toBeLessThan(20)
            fakeClock += latestJob.breathing_interval_ms
            latestJob = await processDumpJobSlice({
                job: latestJob,
                executeSql: async (sql, params) => {
                    if (sql.startsWith('SELECT CAST(_rowid_'))
                        fakeClock += 3_000
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

        expect(alarmTicks).toBeGreaterThanOrEqual(2)
        expect(latestJob.status).toBe('completed')
        expect(latestJob.rows_exported).toBe(
            usersRows.length + ordersRows.length
        )
        expect(latestJob.callback_status).toBe('delivered')
        expect(webhookCalls.length).toBe(1)
        expect(webhookCalls[0].event).toBe('export.dump.completed')
        expect(webhookSawCompleted).toBe(true)
        expect(webhookHadSignal).toBe(true)

        // Strict Cloudflare R2 equal non-final part size invariant
        expect(mockBucket.completedPartSizes.length).toBeGreaterThanOrEqual(3)
        for (let i = 0; i < mockBucket.completedPartSizes.length - 1; i++) {
            expect(mockBucket.completedPartSizes[i]).toBe(512)
        }
        expect(
            mockBucket.completedPartSizes[
                mockBucket.completedPartSizes.length - 1
            ]
        ).toBeLessThanOrEqual(512)

        // All versioned staging keys must be retired/cleaned up
        expect(
            Array.from(mockBucket.objects.keys()).filter((k) =>
                k.includes('.pending.')
            )
        ).toEqual([])

        const dlDone = await downloadDumpJobRoute(
            initJson.result.jobId,
            dsWithR2,
            mockConfig
        )
        expect(dlDone.status).toBe(200)
        expect(await dlDone.text()).toBe(expectedSql)
    })

    it('guarantees unique R2 keys across concurrent same-second ?async=true requests and delegates execution solely to DO alarm', async () => {
        const harness = createInMemorySqlHarness({
            tables: {
                items: {
                    schema: 'CREATE TABLE items (id INTEGER)',
                    rows: makeRows([{ id: 1 }]),
                },
            },
        })
        vi.mocked(executeOperation).mockImplementation(async (q) =>
            harness.executeSql(q[0].sql, q[0].params)
        )
        const mockBucket = new MockR2Bucket()
        const scheduled: number[] = []
        const dsWithR2: DataSource = {
            ...mockDataSource,
            dumpBucket: mockBucket as unknown as R2Bucket,
            rpc: {
                executeQuery: vi.fn(),
                setAlarm: vi.fn(),
                scheduleDumpAlarm: vi.fn(async (ts: number) => {
                    scheduled.push(ts)
                }),
            } as any,
        }

        const fixedNow = Date.parse('2024-01-01T17:00:00.000Z')
        const req = () =>
            new Request('https://starbase.workers.dev/export/dump?async=true')

        // Fire 3 concurrent requests in the exact same millisecond
        const responses = await Promise.all([
            dumpDatabaseRoute(dsWithR2, mockConfig, req(), {
                now: () => fixedNow,
            }),
            dumpDatabaseRoute(dsWithR2, mockConfig, req(), {
                now: () => fixedNow,
            }),
            dumpDatabaseRoute(dsWithR2, mockConfig, req(), {
                now: () => fixedNow,
            }),
        ])
        const summaries = await Promise.all(
            responses.map(async (r) => {
                expect(r.status).toBe(202)
                return ((await r.json()) as { result: any }).result
            })
        )
        const keys = summaries.map((s) => s.key)
        expect(new Set(keys).size).toBe(3)
        expect(keys).toContain('dump_20240101-170000.sql')
        // Worker enqueues only — DO alarm is sole executor
        expect(summaries.every((s) => s.status === 'in_progress')).toBe(true)
        expect(scheduled.length).toBe(3)
    })

    it('versioned R2 staging is crash-safe if DO restarts after R2 put and before SQL commit (zero duplicated bytes)', async () => {
        const mockBucket = new MockR2Bucket()
        const w1 = await R2MultipartDumpWriter.create(
            mockBucket as unknown as R2Bucket,
            'dump_crash.sql',
            5 * 1024 * 1024
        )
        await w1.append('A'.repeat(70_000))
        const staging1 = await w1.checkpointPending()
        expect(staging1).toBe('dump_crash.sql.pending.70000')

        const committedJob: DumpJobRecord = {
            id: 'job-crash',
            status: 'in_progress',
            r2_key: 'dump_crash.sql',
            upload_id: w1.uploadId,
            tables_json: '[]',
            table_index: 0,
            row_offset: 0,
            last_rowid: null,
            parts_json: JSON.stringify(w1.parts),
            pending_staging_key: staging1,
            chunk_size: 500,
            work_budget_ms: 5000,
            breathing_interval_ms: 5000,
            rows_exported: 0,
            bytes_written: 70_000,
            callback_url: null,
            callback_status: null,
            error: null,
            created_at: '2024-01-01T17:00:00.000Z',
            updated_at: '2024-01-01T17:00:00.000Z',
            completed_at: null,
        }

        // Slice 2 writes new versioned staging key, then CRASHES before SQL commit & retirePreviousStaging()
        const w2 = await R2MultipartDumpWriter.resume(
            mockBucket as unknown as R2Bucket,
            committedJob,
            5 * 1024 * 1024
        )
        await w2.append('B'.repeat(50))
        const staging2 = await w2.checkpointPending()
        expect(staging2).toBe('dump_crash.sql.pending.70050')
        // Original staging key MUST still exist untouched!
        expect(mockBucket.objects.has('dump_crash.sql.pending.70000')).toBe(
            true
        )

        // Restart replays from committedJob (still pointing at staging1 = 70000)
        const w3 = await R2MultipartDumpWriter.resume(
            mockBucket as unknown as R2Bucket,
            committedJob,
            5 * 1024 * 1024
        )
        await w3.append('B'.repeat(50))
        await w3.complete()

        const finalBytes = mockBucket.objects.get('dump_crash.sql')!
        expect(finalBytes.byteLength).toBe(70_050)
        expect(w3.bytesWritten).toBe(70_050)
    })

    it('isolates webhook bookkeeping failures so completed backups stay completed with a single webhook event', async () => {
        const harness = createInMemorySqlHarness({
            tables: {
                t: {
                    schema: 'CREATE TABLE t (i INTEGER)',
                    rows: makeRows([{ i: 1 }]),
                },
            },
        })
        const mockBucket = new MockR2Bucket()
        const upload =
            await mockBucket.createMultipartUpload('dump_webhook.sql')
        const job: DumpJobRecord = {
            id: 'job-wh',
            status: 'in_progress',
            r2_key: 'dump_webhook.sql',
            upload_id: upload.uploadId,
            tables_json: JSON.stringify(['t']),
            table_index: 0,
            row_offset: 0,
            last_rowid: null,
            parts_json: '[]',
            pending_staging_key: null,
            chunk_size: 100,
            work_budget_ms: 5000,
            breathing_interval_ms: 5000,
            rows_exported: 0,
            bytes_written: 0,
            callback_url: 'https://hooks.example.com/done',
            callback_status: null,
            error: null,
            created_at: '2024-01-01T17:00:00.000Z',
            updated_at: '2024-01-01T17:00:00.000Z',
            completed_at: null,
        }
        harness.jobs.set(job.id, job)

        const events: string[] = []
        const consoleErrorSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})

        let failCallbackSave = true
        const result = await processDumpJobSlice({
            job,
            executeSql: async (sql, params) => {
                if (
                    failCallbackSave &&
                    sql.includes('INSERT OR REPLACE INTO tmp_dump_jobs') &&
                    params?.includes('delivered')
                ) {
                    failCallbackSave = false
                    throw new Error('transient bookkeeping write failed')
                }
                return harness.executeSql(sql, params)
            },
            bucket: mockBucket as unknown as R2Bucket,
            fetchFn: (async (_u: any, init?: RequestInit) => {
                events.push(JSON.parse(String(init?.body || '{}')).event)
                return new Response('ok', { status: 200 })
            }) as unknown as typeof fetch,
        })

        expect(result.status).toBe('completed')
        expect(harness.jobs.get(job.id)?.status).toBe('completed')
        expect(events).toEqual(['export.dump.completed'])
        consoleErrorSpy.mockRestore()
    })

    it('cleans up reserved job and aborts R2 upload if scheduleDumpAlarm throws during job creation', async () => {
        const harness = createInMemorySqlHarness({
            tables: {
                t: {
                    schema: 'CREATE TABLE t (i INTEGER)',
                    rows: makeRows([{ i: 1 }]),
                },
            },
        })
        vi.mocked(executeOperation).mockImplementation(async (q) =>
            harness.executeSql(q[0].sql, q[0].params)
        )
        const mockBucket = new MockR2Bucket()
        const dsFailAlarm: DataSource = {
            ...mockDataSource,
            dumpBucket: mockBucket as unknown as R2Bucket,
            rpc: {
                executeQuery: vi.fn(),
                setAlarm: vi.fn(),
                scheduleDumpAlarm: vi.fn(async () => {
                    throw new Error('transient setAlarm failure')
                }),
            } as any,
        }
        const consoleErrorSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})

        const res = await dumpDatabaseRoute(
            dsFailAlarm,
            mockConfig,
            new Request('https://starbase.workers.dev/export/dump?async=true')
        )
        expect(res.status).toBe(500)
        expect(harness.jobs.size).toBe(0)
        expect(mockBucket.abortCalls).toBe(1)
        consoleErrorSpy.mockRestore()
    })

    it('aborts R2 multipart upload and notifies callback when resume() fails on missing staging buffer', async () => {
        const harness = createInMemorySqlHarness({
            tables: {
                users: {
                    schema: 'CREATE TABLE users (id INTEGER)',
                    rows: makeRows([{ id: 1 }]),
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
            last_rowid: null,
            parts_json: '[]',
            pending_staging_key: 'dump_20240101-170000.sql.pending.16',
            chunk_size: 2,
            work_budget_ms: 5000,
            breathing_interval_ms: 5000,
            rows_exported: 0,
            bytes_written: 16,
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

    it('returns 400 on ?async=true without DUMP_BUCKET and 404 for unknown job IDs', async () => {
        const harness = createInMemorySqlHarness({ tables: {} })
        vi.mocked(executeOperation).mockImplementation(async (q) =>
            harness.executeSql(q[0].sql, q[0].params)
        )
        const noBucketRes = await dumpDatabaseRoute(
            mockDataSource,
            mockConfig,
            new Request('https://starbase.workers.dev/export/dump?async=true')
        )
        expect(noBucketRes.status).toBe(400)

        const dsWithR2: DataSource = {
            ...mockDataSource,
            dumpBucket: new MockR2Bucket() as unknown as R2Bucket,
        }
        expect(
            (await getDumpJobStatusRoute('missing', dsWithR2, mockConfig))
                .status
        ).toBe(404)
        expect(
            (await downloadDumpJobRoute('missing', dsWithR2, mockConfig)).status
        ).toBe(404)
    })

    it('preserves >2^53 64-bit rowid precision and avoids shadowing user rowid / __sb_rid columns', async () => {
        const harness = createInMemorySqlHarness({
            tables: {
                big_ids: {
                    schema: 'CREATE TABLE big_ids (v TEXT)',
                    rows: [
                        { rowid: 9007199254740995n, data: { v: 'first' } },
                        { rowid: 9007199254740996n, data: { v: 'second' } },
                    ],
                },
                shadowed: {
                    schema: 'CREATE TABLE shadowed (rowid TEXT, __sb_rid TEXT, val INTEGER)',
                    rows: [
                        {
                            rowid: 1,
                            data: { rowid: 'dup', __sb_rid: 'keep1', val: 10 },
                        },
                        {
                            rowid: 2,
                            data: { rowid: 'dup', __sb_rid: 'keep2', val: 20 },
                        },
                    ],
                },
            },
        })
        vi.mocked(executeOperation).mockImplementation(async (q) =>
            harness.executeSql(q[0].sql, q[0].params)
        )

        const res = await dumpDatabaseRoute(
            mockDataSource,
            mockConfig,
            undefined,
            { chunkSize: 1 }
        )
        expect(res.status).toBe(200)
        const sql = await res.text()
        expect(sql).toContain("INSERT INTO big_ids VALUES ('first');")
        expect(sql).toContain("INSERT INTO big_ids VALUES ('second');")
        // User's shadowed rowid and __sb_rid columns MUST BOTH be preserved intact!
        expect(sql).toContain(
            "INSERT INTO shadowed VALUES ('dup', 'keep1', 10);"
        )
        expect(sql).toContain(
            "INSERT INTO shadowed VALUES ('dup', 'keep2', 20);"
        )
    })

    it('adaptively halves page size on wide-row RPC payload errors and exports all rows', async () => {
        const harness = createInMemorySqlHarness({
            tables: {
                wide: {
                    schema: 'CREATE TABLE wide (id INTEGER, body TEXT)',
                    rows: makeRows([
                        { id: 1, body: 'r1' },
                        { id: 2, body: 'r2' },
                        { id: 3, body: 'r3' },
                        { id: 4, body: 'r4' },
                        { id: 5, body: 'r5' },
                    ]),
                },
            },
        })
        const observedLimits: number[] = []
        vi.mocked(executeOperation).mockImplementation(async (q) => {
            const m = q[0].sql.match(/LIMIT (\d+);$/)
            if (m) {
                const lim = Number(m[1])
                observedLimits.push(lim)
                if (lim > 2) {
                    throw new Error(
                        'RPC payload size limit exceeded (1 MiB max)'
                    )
                }
            }
            return harness.executeSql(q[0].sql, q[0].params)
        })

        const res = await dumpDatabaseRoute(
            mockDataSource,
            mockConfig,
            undefined,
            { chunkSize: 8 }
        )
        expect(res.status).toBe(200)
        const sql = await res.text()
        // Must have halved 8 -> 4 -> 2 and exported all 5 rows across 3 pages!
        expect(observedLimits.slice(0, 3)).toEqual([8, 4, 2])
        expect(sql.match(/INSERT INTO wide VALUES/g)?.length).toBe(5)
    })

    it('retains active R2 staging key until AFTER terminal SQL commit succeeds', async () => {
        const harness = createInMemorySqlHarness({
            tables: {
                t: {
                    schema: 'CREATE TABLE t (i INTEGER)',
                    rows: makeRows([{ i: 1 }]),
                },
            },
        })
        const mockBucket = new MockR2Bucket()
        const upload = await mockBucket.createMultipartUpload(
            'dump_term_crash.sql'
        )
        await mockBucket.put(
            'dump_term_crash.sql.pending.16',
            SQLITE_DUMP_HEADER
        )
        const job: DumpJobRecord = {
            id: 'job-term-crash',
            status: 'in_progress',
            r2_key: 'dump_term_crash.sql',
            upload_id: upload.uploadId,
            tables_json: JSON.stringify(['t']),
            table_index: 0,
            row_offset: 0,
            last_rowid: null,
            parts_json: '[]',
            pending_staging_key: 'dump_term_crash.sql.pending.16',
            chunk_size: 100,
            work_budget_ms: 5000,
            breathing_interval_ms: 5000,
            rows_exported: 0,
            bytes_written: 16,
            callback_url: null,
            callback_status: null,
            error: null,
            created_at: '2024-01-01T17:00:00.000Z',
            updated_at: '2024-01-01T17:00:00.000Z',
            completed_at: null,
        }
        harness.jobs.set(job.id, job)

        // Inject failure on terminal SQL commit -> staging object MUST still exist in R2!
        await expect(
            processDumpJobSlice({
                job,
                executeSql: async (sql, params) => {
                    if (sql.includes('INSERT OR REPLACE INTO tmp_dump_jobs')) {
                        throw new Error('SQL commit interrupted')
                    }
                    return harness.executeSql(sql, params)
                },
                bucket: mockBucket as unknown as R2Bucket,
            })
        ).rejects.toThrow('SQL commit interrupted')

        expect(mockBucket.objects.has('dump_term_crash.sql.pending.16')).toBe(
            true
        )
    })

    it('fires completion webhook on synchronous dumps (both streaming and R2-bound fast path)', async () => {
        const harness = createInMemorySqlHarness({
            tables: {
                items: {
                    schema: 'CREATE TABLE items (id INTEGER)',
                    rows: makeRows([{ id: 1 }, { id: 2 }]),
                },
            },
        })
        vi.mocked(executeOperation).mockImplementation(async (q) =>
            harness.executeSql(q[0].sql, q[0].params)
        )

        const calls: { body: any; hasSignal: boolean }[] = []
        const mockFetch = vi.fn(async (_url: any, init?: RequestInit) => {
            calls.push({
                body: JSON.parse(String(init?.body || '{}')),
                hasSignal: init?.signal instanceof AbortSignal,
            })
            return new Response('ok', { status: 200 })
        }) as unknown as typeof fetch

        const req = () =>
            new Request(
                'https://starbase.workers.dev/export/dump?callback_url=https://hooks.example.com/sync'
            )

        // 1. Streaming no-R2 sync dump delivers webhook upon stream completion
        const rStream = await dumpDatabaseRoute(
            mockDataSource,
            mockConfig,
            req(),
            { fetchFn: mockFetch }
        )
        expect(rStream.status).toBe(200)
        await rStream.text()
        expect(calls.length).toBe(1)
        expect(calls[0].body.mode).toBe('sync')
        expect(calls[0].body.rowsExported).toBe(2)
        expect(calls[0].hasSignal).toBe(true)

        // 2. R2-bound fast sync dump also delivers webhook
        const dsWithR2: DataSource = {
            ...mockDataSource,
            dumpBucket: new MockR2Bucket() as unknown as R2Bucket,
        }
        const rFast = await dumpDatabaseRoute(dsWithR2, mockConfig, req(), {
            fetchFn: mockFetch,
        })
        expect(rFast.status).toBe(200)
        expect(calls.length).toBe(2)
        expect(calls[1].body.mode).toBe('sync')
        expect(calls[1].body.rowsExported).toBe(2)
    })
})
