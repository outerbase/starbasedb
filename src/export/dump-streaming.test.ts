import { describe, it, expect, vi, beforeEach } from 'vitest'
import { startStreamingDump, getExportStatus, downloadExport, ExportState } from './dump-streaming'
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

let mockDataSource: DataSource
let mockConfig: StarbaseDBConfiguration
let mockR2Bucket: any
let storedState: Map<string, string>

beforeEach(() => {
    vi.clearAllMocks()
    storedState = new Map()

    mockDataSource = {
        source: 'internal',
        external: undefined,
        rpc: {
            executeQuery: vi.fn(async (opts: any) => {
                // Simulate tmp_export_state table operations
                if (opts.sql.includes('CREATE TABLE')) return []
                if (opts.sql.includes('INSERT INTO tmp_export_state') || opts.sql.includes('UPDATE tmp_export_state')) {
                    if (opts.params) {
                        const id = opts.params[0]
                        const value = opts.params[1] || opts.params[0]
                        storedState.set(String(id), String(value))
                    }
                    return []
                }
                if (opts.sql.includes('SELECT') && opts.sql.includes('tmp_export_state')) {
                    const id = opts.params?.[0]
                    if (id && storedState.has(String(id))) {
                        return [{ export_id: id, value: storedState.get(String(id)) }]
                    }
                    // Check for running exports
                    for (const [key, val] of storedState.entries()) {
                        if (val.includes('"status":"running"')) {
                            return [{ export_id: key, value: val }]
                        }
                    }
                    return []
                }
                return []
            }),
            setAlarm: vi.fn(),
            getAlarm: vi.fn().mockResolvedValue(null),
            deleteAlarm: vi.fn(),
        },
    } as any

    mockConfig = {
        outerbaseApiKey: 'mock-api-key',
        role: 'admin',
        features: { allowlist: true, rls: true, rest: true, export: true },
    }

    // Mock R2 bucket
    mockR2Bucket = {
        createMultipartUpload: vi.fn().mockResolvedValue({
            uploadId: 'test-upload-id',
            uploadPart: vi.fn().mockResolvedValue({ etag: 'etag-1' }),
            complete: vi.fn().mockResolvedValue({}),
            abort: vi.fn().mockResolvedValue({}),
        }),
        resumeMultipartUpload: vi.fn().mockReturnValue({
            uploadPart: vi.fn().mockResolvedValue({ etag: 'etag-2' }),
            complete: vi.fn().mockResolvedValue({}),
            abort: vi.fn().mockResolvedValue({}),
        }),
        put: vi.fn().mockResolvedValue({}),
        get: vi.fn().mockResolvedValue({
            body: new ReadableStream({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode('-- dump content'))
                    controller.close()
                },
            }),
            size: 14,
        }),
    }
})

describe('Streaming Database Export', () => {
    describe('startStreamingDump', () => {
        it('should initiate export and return response', async () => {
            // Mock a database with tables
            vi.mocked(executeOperation)
                .mockResolvedValueOnce([{ name: 'users' }])
                .mockResolvedValueOnce([
                    { sql: 'CREATE TABLE users (id INTEGER, name TEXT);' },
                ])
                .mockResolvedValueOnce([
                    { id: 1, name: 'Alice' },
                    { id: 2, name: 'Bob' },
                ])
                .mockResolvedValueOnce([])

            const response = await startStreamingDump({
                dataSource: mockDataSource,
                config: mockConfig,
                r2Bucket: mockR2Bucket,
            })

            // Should initiate the export successfully (200 or 202)
            expect(response).toBeInstanceOf(Response)
            expect([200, 202]).toContain(response.status)
        })

        it('should create multipart upload on R2', async () => {
            vi.mocked(executeOperation)
                .mockResolvedValueOnce([{ name: 'test_table' }])
                .mockResolvedValueOnce([
                    { sql: 'CREATE TABLE test_table (id INTEGER);' },
                ])
                .mockResolvedValueOnce([{ id: 1 }, { id: 2 }])
                .mockResolvedValueOnce([])

            await startStreamingDump({
                dataSource: mockDataSource,
                config: mockConfig,
                r2Bucket: mockR2Bucket,
            })

            expect(mockR2Bucket.createMultipartUpload).toHaveBeenCalled()
        })

        it('should handle empty database gracefully', async () => {
            vi.mocked(executeOperation).mockResolvedValueOnce([])

            const response = await startStreamingDump({
                dataSource: mockDataSource,
                config: mockConfig,
                r2Bucket: mockR2Bucket,
            })

            expect(response).toBeInstanceOf(Response)
            // Should not crash - either returns empty dump or success message
            expect([200, 202]).toContain(response.status)
        })

        it('should accept callbackUrl parameter', async () => {
            vi.mocked(executeOperation)
                .mockResolvedValueOnce([{ name: 'small_table' }])
                .mockResolvedValueOnce([
                    { sql: 'CREATE TABLE small_table (id INTEGER);' },
                ])
                .mockResolvedValueOnce([{ id: 1 }])
                .mockResolvedValueOnce([])

            const response = await startStreamingDump({
                dataSource: mockDataSource,
                config: mockConfig,
                r2Bucket: mockR2Bucket,
                callbackUrl: 'https://example.com/webhook',
            })

            expect(response).toBeInstanceOf(Response)
        })

        it('should handle database errors gracefully', async () => {
            vi.mocked(executeOperation).mockRejectedValue(
                new Error('Database connection failed')
            )

            const response = await startStreamingDump({
                dataSource: mockDataSource,
                config: mockConfig,
                r2Bucket: mockR2Bucket,
            })

            // Implementation may return 200 with error in body or 500
            expect([200, 500]).toContain(response.status)
        })
    })

    describe('getExportStatus', () => {
        it('should return status for existing export', async () => {
            const testState: ExportState = {
                exportId: 'test-123',
                status: 'running',
                r2Key: 'dump_20260521-120000.sql',
                tables: ['users', 'orders'],
                currentTableIndex: 1,
                currentOffset: 500,
                startedAt: Date.now(),
                partNumber: 2,
                parts: [{ partNumber: 1, etag: 'etag-1' }],
                pendingChunk: '',
            }

            storedState.set('test-123', JSON.stringify(testState))

            const response = await getExportStatus({
                exportId: 'test-123',
                dataSource: mockDataSource,
            })

            expect(response).toBeInstanceOf(Response)
            const json = await response.json()
            expect(json.result.status).toBe('running')
            expect(json.result.currentTableIndex).toBe(1)
        })

        it('should return 404 for non-existent export', async () => {
            const response = await getExportStatus({
                exportId: 'non-existent',
                dataSource: mockDataSource,
            })

            expect(response.status).toBe(404)
        })
    })

    describe('downloadExport', () => {
        it('should stream R2 object for completed export', async () => {
            const testState: ExportState = {
                exportId: 'done-123',
                status: 'completed',
                r2Key: 'dump_20260521-120000.sql',
                tables: ['users'],
                currentTableIndex: 1,
                currentOffset: 0,
                startedAt: Date.now() - 5000,
                completedAt: Date.now(),
                partNumber: 1,
                parts: [],
                pendingChunk: '',
            }

            storedState.set('done-123', JSON.stringify(testState))

            const response = await downloadExport({
                exportId: 'done-123',
                dataSource: mockDataSource,
                r2Bucket: mockR2Bucket,
            })

            expect(response).toBeInstanceOf(Response)
            // Content type may be application/sql or application/x-sqlite3
            expect(['application/sql', 'application/x-sqlite3']).toContain(
                response.headers.get('Content-Type')
            )
            expect(response.headers.get('Content-Disposition')).toContain('dump_')

            const text = await response.text()
            expect(text).toBe('-- dump content')
        })

        it('should return 404 for non-existent export', async () => {
            const response = await downloadExport({
                exportId: 'missing',
                dataSource: mockDataSource,
                r2Bucket: mockR2Bucket,
            })

            expect(response.status).toBe(404)
        })

        it('should return 409 for incomplete export', async () => {
            const testState: ExportState = {
                exportId: 'running-123',
                status: 'running',
                r2Key: 'dump_20260521-120000.sql',
                tables: ['users'],
                currentTableIndex: 0,
                currentOffset: 500,
                startedAt: Date.now(),
                partNumber: 1,
                parts: [],
                pendingChunk: '',
            }

            storedState.set('running-123', JSON.stringify(testState))

            const response = await downloadExport({
                exportId: 'running-123',
                dataSource: mockDataSource,
                r2Bucket: mockR2Bucket,
            })

            expect(response.status).toBe(409)
        })
    })
})
