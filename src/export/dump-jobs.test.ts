import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
    downloadDumpJobRoute,
    getDumpJobStatusRoute,
    startDumpJobRoute,
} from './dump-jobs'
import { executeOperation } from '.'
import type { DataSource } from '../types'
import type { StarbaseDBConfiguration } from '../handler'

vi.mock('.', () => ({
    executeOperation: vi.fn(),
}))

let mockDataSource: DataSource
let mockConfig: StarbaseDBConfiguration

beforeEach(() => {
    vi.clearAllMocks()

    mockDataSource = {
        source: 'internal',
        rpc: { executeQuery: vi.fn() },
    } as any

    mockConfig = {
        role: 'admin',
        features: { export: true },
    }
})

describe('Async Dump Jobs', () => {
    it('starts an async dump job', async () => {
        vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('job-1')

        vi.mocked(executeOperation)
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([{ name: 'users' }])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([])

        const request = new Request('https://example.com/export/dump', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ batchSize: 250 }),
        })

        const response = await startDumpJobRoute(
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(202)
        const payload: { result: { jobId: string } } = await response.json()
        expect(payload.result.jobId).toBe('job-1')
    })

    it('returns 404 when status is requested for unknown job', async () => {
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([])

        const response = await getDumpJobStatusRoute(
            'missing-job',
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(404)
    })

    it('blocks download until job is completed', async () => {
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([
                {
                    job_id: 'job-2',
                    status: 'running',
                    error_message: null,
                    file_name: 'database_dump.sql',
                    batch_size: 500,
                    table_index: 0,
                    row_offset: 0,
                    schema_written: 0,
                    chunk_index: 1,
                    tables_json: '[]',
                    created_at: Date.now(),
                    updated_at: Date.now(),
                    completed_at: null,
                },
            ])

        const response = await downloadDumpJobRoute(
            'job-2',
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(409)
    })

    it('streams completed dump content', async () => {
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([
                {
                    job_id: 'job-3',
                    status: 'completed',
                    error_message: null,
                    file_name: 'database_dump.sql',
                    batch_size: 500,
                    table_index: 1,
                    row_offset: 0,
                    schema_written: 0,
                    chunk_index: 3,
                    tables_json: '["users"]',
                    created_at: Date.now(),
                    updated_at: Date.now(),
                    completed_at: Date.now(),
                },
            ])
            .mockResolvedValueOnce([
                { content: 'SQLite format 3\0' },
                { content: "\nINSERT INTO \"users\" VALUES (1, 'Alice');\n" },
            ])
            .mockResolvedValueOnce([])

        const response = await downloadDumpJobRoute(
            'job-3',
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(200)
        expect(response.headers.get('Content-Type')).toBe('application/x-sqlite3')

        const text = await response.text()
        expect(text).toContain('SQLite format 3\0')
        expect(text).toContain('INSERT INTO "users" VALUES (1, \'Alice\');')
    })
})
