import { describe, it, expect, vi, beforeEach } from 'vitest'
import { StarbaseDB } from '../handler'
import type { DataSource } from '../types'
import type { StarbaseDBConfiguration } from '../handler'

/**
 * Bug Condition Exploration Test — Async Chunked Export
 *
 *
 *
 * These tests encode the EXPECTED behavior for async export routes:
 *   - POST /export/dump with { async: true } → 202 with jobId and statusUrl
 *   - GET /export/jobs/:jobId → valid job status
 *   - GET /export/jobs/:jobId/download → file download for completed jobs
 *
 * On UNFIXED code, these routes do not exist. The Hono notFound handler
 * returns 404, which confirms the bug condition: there is no async export
 * path available, so large exports have no alternative to the synchronous
 * path that times out.
 */

let instance: StarbaseDB
let mockDataSource: DataSource
let mockConfig: StarbaseDBConfiguration

const mockExecutionContext = {
    waitUntil: vi.fn(),
} as unknown as ExecutionContext

beforeEach(() => {
    vi.clearAllMocks()

    const mockExecuteQuery = vi.fn().mockResolvedValue([])
    ;(mockExecuteQuery as any)[Symbol.dispose] = vi.fn()

    const mockCreateExportJob = vi.fn().mockResolvedValue({
        jobId: 'export_20240101-120000_abc123',
        statusUrl: '/export/jobs/export_20240101-120000_abc123',
        estimatedTables: 3,
    })

    const mockGetExportJob = vi.fn().mockImplementation((jobId: string) => {
        if (jobId === 'test-job-123') {
            return Promise.resolve(null)
        }
        return Promise.resolve(null)
    })

    const mockSetAlarm = vi.fn().mockResolvedValue(undefined)

    const mockR2Bucket = {
        get: vi.fn().mockResolvedValue(null),
        put: vi.fn().mockResolvedValue(undefined),
        createMultipartUpload: vi.fn().mockResolvedValue({
            uploadId: 'test-upload-id',
            uploadPart: vi.fn(),
            complete: vi.fn(),
            abort: vi.fn(),
        }),
    } as unknown as R2Bucket

    mockDataSource = {
        source: 'internal',
        rpc: {
            executeQuery: mockExecuteQuery,
            createExportJob: mockCreateExportJob,
            getExportJob: mockGetExportJob,
            setAlarm: mockSetAlarm,
            getAlarm: vi.fn(),
            deleteAlarm: vi.fn(),
            getStatistics: vi.fn(),
        } as any,
        r2ExportBucket: mockR2Bucket,
    }

    mockConfig = {
        role: 'admin',
        features: { export: true },
    }

    instance = new StarbaseDB({
        dataSource: mockDataSource,
        config: mockConfig,
    })
})

describe('Async Chunked Export — Bug Condition Exploration', () => {
    describe('POST /export/dump (async export initiation)', () => {
        it('should return 202 Accepted with jobId and statusUrl when async: true', async () => {
            const request = new Request('https://example.com/export/dump', {
                method: 'POST',
                body: JSON.stringify({ async: true, format: 'sql' }),
                headers: { 'Content-Type': 'application/json' },
            })

            const response = await instance.handle(
                request,
                mockExecutionContext
            )
            expect(response.status).toBe(202)

            const body = (await response.json()) as any
            expect(body.result).toBeDefined()
            expect(body.result.jobId).toBeDefined()
            expect(typeof body.result.jobId).toBe('string')
            expect(body.result.statusUrl).toBeDefined()
            expect(typeof body.result.statusUrl).toBe('string')
        })
    })

    describe('GET /export/jobs/:jobId (job status)', () => {
        it('should return a valid job status object for an existing job', async () => {
            const request = new Request(
                'https://example.com/export/jobs/test-job-123',
                { method: 'GET' }
            )

            const response = await instance.handle(
                request,
                mockExecutionContext
            )

            // On fixed code this should return 200 with job status
            // (or 404 if the job doesn't exist, but the route itself must exist)
            expect([200, 404]).toContain(response.status)

            // The route must exist — a 404 from the route handler (job not found)
            // is different from a 404 from Hono's notFound (route not registered).
            // If the route is registered, the response body should have our
            // standard { result, error } shape with the error field.
            const body = (await response.json()) as any
            expect(body).toHaveProperty('error')
        })
    })

    describe('GET /export/jobs/:jobId/download (file download)', () => {
        it('should return a response from the download route for a job', async () => {
            const request = new Request(
                'https://example.com/export/jobs/test-job-123/download',
                { method: 'GET' }
            )

            const response = await instance.handle(
                request,
                mockExecutionContext
            )

            // On fixed code this should return 200 (file) or 400 (not completed)
            // or 404 (job not found). The route must exist.
            expect([200, 400, 404]).toContain(response.status)

            const body = (await response.json()) as any
            expect(body).toHaveProperty('error')
        })
    })
})
