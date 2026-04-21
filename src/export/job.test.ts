import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
    generateJobId,
    createExportJob,
    processExportChunk,
    completeExportJob,
    failExportJob,
    getExportJob,
    deliverCallback,
} from './job'
import { formatChunkAsSQL, formatChunkAsJSON, formatChunkAsCSV } from './format'
import type { DataSource } from '../types'
import type { StarbaseDBConfiguration } from '../handler'

/**
 * Comprehensive tests for the async chunked export feature.
 *
 * These tests exercise the actual job lifecycle functions with realistic
 * mocks that track state — not just route existence checks.
 */

// ── Shared mock infrastructure ──────────────────────────────────────

let mockExecuteOperation: ReturnType<typeof vi.fn>

vi.mock('.', () => ({
    executeOperation: (...args: any[]) => mockExecuteOperation(...args),
}))

// In-memory store simulating the tmp_export_jobs table
let jobStore: Record<string, any>

// In-memory store simulating R2 parts
let r2Parts: { partNumber: number; data: string; etag: string }[]
let r2Completed: boolean
let r2Aborted: boolean
let r2FinalObject: string | null

function createMockR2Bucket() {
    r2Parts = []
    r2Completed = false
    r2Aborted = false
    r2FinalObject = null

    const mockMultipartUpload = {
        uploadId: 'mock-upload-id',
        key: '',
        uploadPart: vi.fn(async (partNumber: number, data: any) => {
            const text =
                typeof data === 'string' ? data : new TextDecoder().decode(data)
            const etag = `etag-${partNumber}`
            r2Parts.push({ partNumber, data: text, etag })
            return { partNumber, etag }
        }),
        complete: vi.fn(async (parts: any[]) => {
            r2Completed = true
            r2FinalObject = r2Parts.map((p) => p.data).join('')
        }),
        abort: vi.fn(async () => {
            r2Aborted = true
        }),
    }

    return {
        createMultipartUpload: vi.fn(async (key: string) => {
            mockMultipartUpload.key = key
            return mockMultipartUpload
        }),
        resumeMultipartUpload: vi.fn((key: string, uploadId: string) => {
            return mockMultipartUpload
        }),
        get: vi.fn(async (key: string) => {
            if (r2FinalObject !== null) {
                return {
                    body: new ReadableStream({
                        start(controller) {
                            controller.enqueue(
                                new TextEncoder().encode(r2FinalObject!)
                            )
                            controller.close()
                        },
                    }),
                }
            }
            return null
        }),
        put: vi.fn(async () => {}),
        _multipartUpload: mockMultipartUpload,
    } as any
}

let mockBucket: ReturnType<typeof createMockR2Bucket>
let dataSource: DataSource
let config: StarbaseDBConfiguration

beforeEach(() => {
    vi.clearAllMocks()
    jobStore = {}
    mockBucket = createMockR2Bucket()

    dataSource = {
        source: 'internal',
        rpc: { executeQuery: vi.fn() } as any,
        r2ExportBucket: mockBucket,
    }

    config = { role: 'admin', features: { export: true } }

    // Default mock: route SQL calls to our in-memory store
    mockExecuteOperation = vi.fn(async (queries, ds, cfg) => {
        const sql: string = queries[0].sql
        const params: any[] = queries[0].params || []

        // INSERT into tmp_export_jobs
        if (sql.includes('INSERT INTO tmp_export_jobs')) {
            const job = {
                id: params[0],
                format: params[1],
                status: 'pending',
                target_table: params[2],
                r2_key: params[3],
                r2_upload_id: params[4],
                total_tables: params[5],
                callback_url: params[6],
                current_table: null,
                current_offset: 0,
                completed_tables: 0,
                bytes_written: 0,
                parts_uploaded: '[]',
                error_message: null,
                created_at: new Date().toISOString(),
                completed_at: null,
            }
            jobStore[job.id] = job
            return []
        }

        // SELECT from tmp_export_jobs
        if (sql.includes('SELECT * FROM tmp_export_jobs WHERE id')) {
            const job = jobStore[params[0]]
            return job ? [job] : []
        }

        // UPDATE tmp_export_jobs SET status = 'in_progress'
        if (sql.includes("status = 'in_progress'")) {
            if (jobStore[params[0]]) jobStore[params[0]].status = 'in_progress'
            return []
        }

        // UPDATE progress
        if (
            sql.includes('current_table = ?') &&
            sql.includes('current_offset = ?')
        ) {
            const jobId = params[5]
            if (jobStore[jobId]) {
                jobStore[jobId].current_table = params[0]
                jobStore[jobId].current_offset = params[1]
                jobStore[jobId].completed_tables = params[2]
                jobStore[jobId].bytes_written = params[3]
                jobStore[jobId].parts_uploaded = params[4]
            }
            return []
        }

        // UPDATE status = 'completed'
        if (sql.includes("status = 'completed'")) {
            if (jobStore[params[0]]) {
                jobStore[params[0]].status = 'completed'
                jobStore[params[0]].completed_at = new Date().toISOString()
            }
            return []
        }

        // UPDATE status = 'failed'
        if (sql.includes("status = 'failed'")) {
            if (jobStore[params[1]]) {
                jobStore[params[1]].status = 'failed'
                jobStore[params[1]].error_message = params[0]
                jobStore[params[1]].completed_at = new Date().toISOString()
            }
            return []
        }

        // SELECT tables from sqlite_master
        if (
            sql.includes('sqlite_master') &&
            sql.includes("type='table'") &&
            !sql.includes('name=')
        ) {
            return [{ name: 'users' }, { name: 'orders' }]
        }

        // SELECT schema for a table
        if (sql.includes('sqlite_master') && sql.includes('name=?')) {
            const tableName = params[0]
            return [
                {
                    sql: `CREATE TABLE ${tableName} (id INTEGER PRIMARY KEY, name TEXT)`,
                },
            ]
        }

        // SELECT rows from a table (LIMIT/OFFSET)
        if (sql.includes('LIMIT') && sql.includes('OFFSET')) {
            const limit = params[0]
            const offset = params[1]
            if (offset >= 3) return [] // simulate 3 rows per table
            const remaining = Math.min(limit, 3 - offset)
            const rows = []
            for (let i = 0; i < remaining; i++) {
                rows.push({ id: offset + i + 1, name: `row_${offset + i + 1}` })
            }
            return rows
        }

        return []
    })
})

// ── Format helpers ──────────────────────────────────────────────────

describe('formatChunkAsSQL', () => {
    it('produces valid INSERT statements', () => {
        const rows = [
            { id: 1, name: 'Alice' },
            { id: 2, name: "Bob's" },
        ]
        const sql = formatChunkAsSQL('users', rows)
        expect(sql).toContain("INSERT INTO users VALUES (1, 'Alice');")
        expect(sql).toContain("INSERT INTO users VALUES (2, 'Bob''s');")
    })

    it('handles NULL values', () => {
        const rows = [{ id: 1, name: null }]
        const sql = formatChunkAsSQL('t', rows)
        expect(sql).toContain('NULL')
    })

    it('handles empty rows', () => {
        expect(formatChunkAsSQL('t', [])).toBe('')
    })
})

describe('formatChunkAsJSON', () => {
    it('wraps first chunk with opening bracket', () => {
        const out = formatChunkAsJSON([{ id: 1 }], true, false)
        expect(out.startsWith('[\n')).toBe(true)
        expect(out).not.toContain(']')
    })

    it('wraps last chunk with closing bracket', () => {
        const out = formatChunkAsJSON([{ id: 1 }], false, true)
        expect(out.endsWith('\n]')).toBe(true)
    })

    it('single-chunk (first AND last) produces valid JSON array', () => {
        const out = formatChunkAsJSON([{ id: 1 }, { id: 2 }], true, true)
        const parsed = JSON.parse(out)
        expect(parsed).toEqual([{ id: 1 }, { id: 2 }])
    })

    it('middle chunk has no brackets', () => {
        const out = formatChunkAsJSON([{ id: 5 }], false, false)
        expect(out).not.toContain('[')
        expect(out).not.toContain(']')
        expect(out).toContain(',')
    })
})

describe('formatChunkAsCSV', () => {
    it('includes headers when requested', () => {
        const out = formatChunkAsCSV([{ id: 1, name: 'A' }], true)
        expect(out.startsWith('id,name\n')).toBe(true)
    })

    it('omits headers when not requested', () => {
        const out = formatChunkAsCSV([{ id: 1, name: 'A' }], false)
        expect(out).toBe('1,A\n')
    })

    it('escapes commas and quotes', () => {
        const out = formatChunkAsCSV([{ v: 'a,b' }, { v: 'c"d' }], false)
        expect(out).toContain('"a,b"')
        expect(out).toContain('"c""d"')
    })

    it('returns empty string for empty rows', () => {
        expect(formatChunkAsCSV([], true)).toBe('')
    })
})

// ── generateJobId ───────────────────────────────────────────────────

describe('generateJobId', () => {
    it('returns a string matching export_YYYYMMDD-HHmmss_<random>', () => {
        const id = generateJobId()
        expect(id).toMatch(/^export_\d{8}-\d{6}_[a-z0-9]+$/)
    })

    it('generates unique IDs', () => {
        const ids = new Set(Array.from({ length: 50 }, () => generateJobId()))
        expect(ids.size).toBe(50)
    })
})

// ── createExportJob ─────────────────────────────────────────────────

describe('createExportJob', () => {
    it('creates a job, initiates R2 multipart upload, and returns jobId', async () => {
        const result = await createExportJob({
            format: 'sql',
            dataSource,
            config,
        })

        expect(result.jobId).toMatch(/^export_/)
        expect(result.statusUrl).toBe(`/export/jobs/${result.jobId}`)
        expect(result.estimatedTables).toBe(2) // users + orders
        expect(mockBucket.createMultipartUpload).toHaveBeenCalledTimes(1)

        // Job should be in our store
        const job = jobStore[result.jobId]
        expect(job).toBeDefined()
        expect(job.status).toBe('pending')
        expect(job.format).toBe('sql')
        expect(job.r2_upload_id).toBe('mock-upload-id')
    })

    it('throws when EXPORT_BUCKET is missing', async () => {
        const noBucketDS = { ...dataSource, r2ExportBucket: undefined }
        await expect(
            createExportJob({ format: 'sql', dataSource: noBucketDS, config })
        ).rejects.toThrow('EXPORT_BUCKET')
    })

    it('sets target_table when provided', async () => {
        const result = await createExportJob({
            format: 'csv',
            targetTable: 'users',
            dataSource,
            config,
        })
        const job = jobStore[result.jobId]
        expect(job.target_table).toBe('users')
        expect(result.estimatedTables).toBe(1)
    })

    it('stores callbackUrl in the job', async () => {
        const result = await createExportJob({
            format: 'json',
            callbackUrl: 'https://example.com/hook',
            dataSource,
            config,
        })
        expect(jobStore[result.jobId].callback_url).toBe(
            'https://example.com/hook'
        )
    })
})

// ── processExportChunk ──────────────────────────────────────────────

describe('processExportChunk', () => {
    let jobId: string

    beforeEach(async () => {
        const result = await createExportJob({
            format: 'sql',
            dataSource,
            config,
        })
        jobId = result.jobId
    })

    it('transitions job from pending to in_progress', async () => {
        await processExportChunk({ jobId, dataSource, config })
        expect(jobStore[jobId].status).toBe('in_progress')
    })

    it('uploads a chunk to R2 with formatted SQL data', async () => {
        await processExportChunk({ jobId, dataSource, config })

        expect(r2Parts.length).toBeGreaterThan(0)
        const uploadedText = r2Parts[0].data
        expect(uploadedText).toContain('INSERT INTO')
        expect(uploadedText).toContain('-- Table:')
        expect(uploadedText).toContain('CREATE TABLE')
    })

    it('updates bytes_written and parts_uploaded', async () => {
        await processExportChunk({ jobId, dataSource, config })

        const job = jobStore[jobId]
        expect(job.bytes_written).toBeGreaterThan(0)
        const parts = JSON.parse(job.parts_uploaded)
        expect(parts.length).toBeGreaterThan(0)
        expect(parts[0]).toHaveProperty('partNumber')
        expect(parts[0]).toHaveProperty('etag')
    })

    it('returns false when all tables are processed (no more work)', async () => {
        const hasMore = await processExportChunk({ jobId, dataSource, config })
        // With 2 tables × 3 rows each, all fit in one batch (< 5000)
        expect(hasMore).toBe(false)
    })

    it('throws when job does not exist', async () => {
        await expect(
            processExportChunk({
                jobId: 'nonexistent',
                dataSource,
                config,
            })
        ).rejects.toThrow('not found')
    })

    it('formats as JSON when format is json', async () => {
        const result = await createExportJob({
            format: 'json',
            dataSource,
            config,
        })
        await processExportChunk({
            jobId: result.jobId,
            dataSource,
            config,
        })

        const uploadedText = r2Parts[r2Parts.length - 1].data
        expect(uploadedText).toContain('[')
        expect(uploadedText).toContain('"id"')
    })

    it('formats as CSV when format is csv', async () => {
        const result = await createExportJob({
            format: 'csv',
            dataSource,
            config,
        })
        await processExportChunk({
            jobId: result.jobId,
            dataSource,
            config,
        })

        const uploadedText = r2Parts[r2Parts.length - 1].data
        expect(uploadedText).toContain('id,name')
    })
})

// ── completeExportJob ───────────────────────────────────────────────

describe('completeExportJob', () => {
    it('finalizes R2 multipart upload and marks job completed', async () => {
        const result = await createExportJob({
            format: 'sql',
            dataSource,
            config,
        })
        await processExportChunk({
            jobId: result.jobId,
            dataSource,
            config,
        })
        await completeExportJob({
            jobId: result.jobId,
            dataSource,
            config,
        })

        expect(r2Completed).toBe(true)
        expect(jobStore[result.jobId].status).toBe('completed')
        expect(jobStore[result.jobId].completed_at).toBeDefined()
    })

    it('handles empty export (no parts) by aborting multipart and putting empty object', async () => {
        // Create a job but mock tables to return empty
        mockExecuteOperation.mockImplementation(async (queries: any) => {
            const sql = queries[0].sql
            const params = queries[0].params || []
            if (sql.includes('INSERT INTO tmp_export_jobs')) {
                jobStore[params[0]] = {
                    id: params[0],
                    format: params[1],
                    status: 'pending',
                    target_table: null,
                    r2_key: params[3],
                    r2_upload_id: params[4],
                    total_tables: 0,
                    callback_url: null,
                    current_table: null,
                    current_offset: 0,
                    completed_tables: 0,
                    bytes_written: 0,
                    parts_uploaded: '[]',
                    error_message: null,
                    created_at: new Date().toISOString(),
                    completed_at: null,
                }
                return []
            }
            if (sql.includes('SELECT * FROM tmp_export_jobs WHERE id')) {
                return jobStore[params[0]] ? [jobStore[params[0]]] : []
            }
            if (sql.includes("status = 'completed'")) {
                if (jobStore[params[0]]) {
                    jobStore[params[0]].status = 'completed'
                    jobStore[params[0]].completed_at = new Date().toISOString()
                }
                return []
            }
            if (sql.includes('sqlite_master')) return []
            return []
        })

        const result = await createExportJob({
            format: 'sql',
            dataSource,
            config,
        })
        await completeExportJob({
            jobId: result.jobId,
            dataSource,
            config,
        })

        expect(r2Aborted).toBe(true)
        expect(mockBucket.put).toHaveBeenCalled()
        expect(jobStore[result.jobId].status).toBe('completed')
    })
})

// ── failExportJob ───────────────────────────────────────────────────

describe('failExportJob', () => {
    it('marks job as failed with error message and aborts R2 upload', async () => {
        const result = await createExportJob({
            format: 'sql',
            dataSource,
            config,
        })

        await failExportJob({
            jobId: result.jobId,
            errorMessage: 'Something broke',
            dataSource,
            config,
        })

        expect(jobStore[result.jobId].status).toBe('failed')
        expect(jobStore[result.jobId].error_message).toBe('Something broke')
        expect(r2Aborted).toBe(true)
    })
})

// ── getExportJob ────────────────────────────────────────────────────

describe('getExportJob', () => {
    it('returns the job when it exists', async () => {
        const result = await createExportJob({
            format: 'sql',
            dataSource,
            config,
        })
        const job = await getExportJob(result.jobId, dataSource, config)
        expect(job).toBeDefined()
        expect(job!.id).toBe(result.jobId)
    })

    it('returns null when job does not exist', async () => {
        const job = await getExportJob('nope', dataSource, config)
        expect(job).toBeNull()
    })
})

// ── deliverCallback ─────────────────────────────────────────────────

describe('deliverCallback', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    beforeEach(() => {
        fetchSpy.mockResolvedValue(new Response('ok'))
    })

    it('POSTs to callback_url on completion with downloadUrl', async () => {
        await deliverCallback({
            job: {
                id: 'j1',
                status: 'completed',
                callback_url: 'https://hook.test/done',
            } as any,
            downloadUrl: '/export/jobs/j1/download',
        })

        expect(fetchSpy).toHaveBeenCalledWith(
            'https://hook.test/done',
            expect.objectContaining({
                method: 'POST',
                body: expect.stringContaining('"downloadUrl"'),
            })
        )
    })

    it('POSTs to callback_url on failure with error_message', async () => {
        await deliverCallback({
            job: {
                id: 'j2',
                status: 'failed',
                callback_url: 'https://hook.test/fail',
                error_message: 'timeout',
            } as any,
        })

        expect(fetchSpy).toHaveBeenCalledWith(
            'https://hook.test/fail',
            expect.objectContaining({
                method: 'POST',
                body: expect.stringContaining('"error_message"'),
            })
        )
    })

    it('does nothing when callback_url is null', async () => {
        fetchSpy.mockClear()
        await deliverCallback({
            job: { id: 'j3', status: 'completed', callback_url: null } as any,
        })
        expect(fetchSpy).not.toHaveBeenCalled()
    })

    it('does not throw when fetch fails', async () => {
        fetchSpy.mockRejectedValueOnce(new Error('network'))
        const consoleSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})

        await expect(
            deliverCallback({
                job: {
                    id: 'j4',
                    status: 'completed',
                    callback_url: 'https://hook.test/x',
                } as any,
            })
        ).resolves.not.toThrow()

        consoleSpy.mockRestore()
    })
})

// ── Full lifecycle integration ──────────────────────────────────────

describe('Full export lifecycle (create → process → complete)', () => {
    it('SQL: creates job, processes all chunks, completes, and R2 has valid content', async () => {
        const result = await createExportJob({
            format: 'sql',
            dataSource,
            config,
        })

        // Process chunks until done
        let hasMore = true
        let iterations = 0
        while (hasMore && iterations < 100) {
            hasMore = await processExportChunk({
                jobId: result.jobId,
                dataSource,
                config,
            })
            iterations++
        }

        await completeExportJob({
            jobId: result.jobId,
            dataSource,
            config,
        })

        expect(r2Completed).toBe(true)
        expect(r2FinalObject).toBeDefined()
        expect(r2FinalObject).toContain('CREATE TABLE users')
        expect(r2FinalObject).toContain('CREATE TABLE orders')
        expect(r2FinalObject).toContain('INSERT INTO users')
        expect(r2FinalObject).toContain('INSERT INTO orders')

        const job = jobStore[result.jobId]
        expect(job.status).toBe('completed')
        expect(job.bytes_written).toBeGreaterThan(0)
    })

    it('JSON: produces valid JSON array across the full lifecycle', async () => {
        const result = await createExportJob({
            format: 'json',
            dataSource,
            config,
        })

        let hasMore = true
        while (hasMore) {
            hasMore = await processExportChunk({
                jobId: result.jobId,
                dataSource,
                config,
            })
        }

        await completeExportJob({
            jobId: result.jobId,
            dataSource,
            config,
        })

        expect(r2Completed).toBe(true)
        expect(r2FinalObject).toBeDefined()
        // The JSON output should be parseable
        const parsed = JSON.parse(r2FinalObject!)
        expect(Array.isArray(parsed)).toBe(true)
        expect(parsed.length).toBeGreaterThan(0)
        expect(parsed[0]).toHaveProperty('id')
        expect(parsed[0]).toHaveProperty('name')
    })

    it('CSV: produces valid CSV with headers across the full lifecycle', async () => {
        const result = await createExportJob({
            format: 'csv',
            dataSource,
            config,
        })

        let hasMore = true
        while (hasMore) {
            hasMore = await processExportChunk({
                jobId: result.jobId,
                dataSource,
                config,
            })
        }

        await completeExportJob({
            jobId: result.jobId,
            dataSource,
            config,
        })

        expect(r2Completed).toBe(true)
        const lines = r2FinalObject!.trim().split('\n')
        expect(lines[0]).toBe('id,name') // header
        expect(lines.length).toBeGreaterThan(1) // header + data rows
    })
})
