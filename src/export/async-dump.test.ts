import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
    downloadAsyncDumpRoute,
    getAsyncDumpStatusRoute,
    startAsyncDumpRoute,
} from './async-dump'
import { executeOperation } from '.'
import type { DataSource } from '../types'
import type { StarbaseDBConfiguration } from '../handler'

vi.mock('.', () => ({
    executeOperation: vi.fn(),
    quoteIdentifier: vi.fn(
        (identifier: string) => `"${identifier.replace(/"/g, '""')}"`
    ),
    createStreamingExportResponse: vi.fn((stream, fileName, contentType) => {
        return new Response(stream, {
            headers: {
                'Content-Type': contentType,
                'Content-Disposition': `attachment; filename="${fileName}"`,
            },
        })
    }),
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
        source: 'internal',
        rpc: {
            executeQuery: vi.fn(),
            setAlarm: vi.fn(),
        },
    } as any

    mockConfig = {
        role: 'admin',
        features: { export: true },
    }
})

describe('Async Dump Export', () => {
    it('returns 400 when callback URL is invalid', async () => {
        const response = await startAsyncDumpRoute(
            new Request('https://example.com/export/dump', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ callbackUrl: 'not-a-valid-url' }),
            }),
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(400)
    })

    it('returns 500 when async dump start fails', async () => {
        vi.mocked(executeOperation).mockRejectedValue(new Error('boom'))

        const response = await startAsyncDumpRoute(
            new Request('https://example.com/export/dump', { method: 'POST' }),
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(500)
        const payload = (await response.json()) as { error: string }
        expect(payload.error).toBe('boom')
    })

    it('starts async dump and returns accepted payload', async () => {
        const now = Date.now()
        let isCompleted = false

        vi.spyOn(crypto, 'randomUUID').mockReturnValue(
            '00000000-0000-4000-8000-000000000001'
        )
        vi.mocked(executeOperation).mockImplementation(async (queries) => {
            const sql = queries[0]?.sql ?? ''

            if (
                sql.includes(
                    "SELECT name FROM sqlite_master WHERE type='table'"
                )
            ) {
                return [{ name: 'users' }]
            }

            if (sql.includes('SELECT * FROM tmp_export_jobs WHERE id = ?')) {
                return [
                    {
                        id: '00000000-0000-4000-8000-000000000001',
                        status: isCompleted ? 'completed' : 'processing',
                        error: null,
                        created_at: now,
                        updated_at: now,
                        started_at: now,
                        completed_at: isCompleted ? now : null,
                        current_table_index: isCompleted ? 1 : 0,
                        current_offset: 0,
                        chunk_index: isCompleted ? 3 : 1,
                        total_tables: 1,
                    },
                ]
            }

            if (
                sql.includes('SELECT table_name') &&
                sql.includes('tmp_export_job_tables')
            ) {
                return [{ table_name: 'users' }]
            }

            if (
                sql.includes("SELECT sql FROM sqlite_master WHERE type='table'")
            ) {
                return [{ sql: 'CREATE TABLE users (id INTEGER);' }]
            }

            if (sql.includes('SELECT * FROM "users" LIMIT ? OFFSET ?')) {
                return []
            }

            if (sql.includes("SET status = 'completed'")) {
                isCompleted = true
                return []
            }

            return []
        })

        const response = await startAsyncDumpRoute(
            new Request('https://example.com/export/dump', { method: 'POST' }),
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(201)
        const payload = (await response.json()) as {
            result: { jobId: string; status: string; downloadUrl?: string }
        }
        expect(payload.result.jobId).toBe(
            '00000000-0000-4000-8000-000000000001'
        )
        expect(payload.result.status).toBe('completed')
        expect(payload.result.downloadUrl).toContain(
            '/export/dump/00000000-0000-4000-8000-000000000001/download'
        )
    })

    it('returns 404 for unknown status job', async () => {
        vi.mocked(executeOperation).mockResolvedValue([])

        const response = await getAsyncDumpStatusRoute(
            'missing',
            new Request('https://example.com/export/dump/missing'),
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(404)
    })

    it('schedules callback retry metadata when callback delivery fails', async () => {
        const fetchMock = vi
            .spyOn(globalThis, 'fetch')
            .mockRejectedValue(new Error('network down'))

        let call = 0
        vi.mocked(executeOperation).mockImplementation(async (queries) => {
            const sql = queries[0]?.sql ?? ''

            if (sql.includes('SELECT * FROM tmp_export_jobs WHERE id = ?')) {
                call += 1

                if (call === 1) {
                    return [
                        {
                            id: 'job-callback',
                            status: 'completed',
                            error: null,
                            callback_url: 'https://callback.example/notify',
                            callback_sent: 0,
                            callback_attempts: 0,
                            next_callback_retry_at: null,
                            callback_host: 'https://example.com',
                            artifact_key: 'dump_job-callback.sql',
                            artifact_provider: 'durable-object',
                            created_at: 0,
                            updated_at: 0,
                            started_at: 0,
                            completed_at: 0,
                            current_table_index: 1,
                            current_offset: 0,
                            chunk_index: 3,
                            total_tables: 1,
                        },
                    ]
                }

                return [
                    {
                        id: 'job-callback',
                        status: 'completed',
                        error: 'network down',
                        callback_url: 'https://callback.example/notify',
                        callback_sent: 0,
                        callback_attempts: 1,
                        next_callback_retry_at: Date.now() + 5000,
                        callback_host: 'https://example.com',
                        artifact_key: 'dump_job-callback.sql',
                        artifact_provider: 'durable-object',
                        created_at: 0,
                        updated_at: 0,
                        started_at: 0,
                        completed_at: 0,
                        current_table_index: 1,
                        current_offset: 0,
                        chunk_index: 3,
                        total_tables: 1,
                    },
                ]
            }

            return []
        })

        const response = await getAsyncDumpStatusRoute(
            'job-callback',
            new Request('https://example.com/export/dump/job-callback'),
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(200)
        expect(
            vi
                .mocked(executeOperation)
                .mock.calls.some(([queries]) =>
                    String(queries[0]?.sql || '').includes(
                        'callback_attempts = ?'
                    )
                )
        ).toBe(true)

        const payload = (await response.json()) as {
            result: {
                callback?: {
                    attempts: number
                }
            }
        }
        expect(payload.result.callback?.attempts).toBe(1)

        fetchMock.mockRestore()
    })

    it('returns 404 for unknown download job', async () => {
        vi.mocked(executeOperation).mockResolvedValue([])

        const response = await downloadAsyncDumpRoute(
            'missing',
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(404)
    })

    it('returns 409 when download job is still processing', async () => {
        vi.mocked(executeOperation).mockResolvedValue([
            {
                id: 'job-1',
                status: 'processing',
                error: null,
                created_at: 0,
                updated_at: 0,
                started_at: 0,
                completed_at: null,
                current_table_index: 0,
                current_offset: 0,
                chunk_index: 1,
                total_tables: 1,
            },
        ])

        const response = await downloadAsyncDumpRoute(
            'job-1',
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(409)
    })

    it('streams completed dump content', async () => {
        const completedJob = [
            {
                id: 'job-1',
                status: 'completed',
                error: null,
                created_at: 0,
                updated_at: 0,
                started_at: 0,
                completed_at: 0,
                current_table_index: 1,
                current_offset: 0,
                chunk_index: 3,
                total_tables: 1,
            },
        ]

        vi.mocked(executeOperation)
            .mockResolvedValueOnce(completedJob)
            .mockResolvedValueOnce([
                { content: 'SQLite format 3\0' },
                { content: '\n-- Table: users\n' },
            ])
            .mockResolvedValueOnce([])

        const response = await downloadAsyncDumpRoute(
            'job-1',
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(200)
        expect(response.headers.get('Content-Type')).toBe(
            'application/x-sqlite3'
        )
        const dump = await response.text()
        expect(dump).toContain('SQLite format 3\0')
        expect(dump).toContain('-- Table: users')
    })
})
