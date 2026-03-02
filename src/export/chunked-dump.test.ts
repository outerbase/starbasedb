import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
    generateDumpFilename,
    generateExportId,
    initializeExport,
    processExportChunk,
    exportStatusRoute,
    exportDownloadRoute,
    ExportState,
} from './chunked-dump'
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

function createMockR2Bucket(content: string = ''): any {
    return {
        put: vi.fn().mockResolvedValue(undefined),
        get: vi.fn().mockResolvedValue({
            text: vi.fn().mockResolvedValue(content),
            body: new ReadableStream(),
            size: content.length,
        }),
        delete: vi.fn().mockResolvedValue(undefined),
    }
}

beforeEach(() => {
    vi.clearAllMocks()

    mockDataSource = {
        source: 'internal',
        rpc: { executeQuery: vi.fn() },
    } as any

    mockConfig = {
        outerbaseApiKey: 'mock-api-key',
        role: 'admin',
        features: { allowlist: true, rls: true, rest: true },
    }

    mockR2Bucket = createMockR2Bucket()
})

describe('Chunked Export Utilities', () => {
    it('should generate a valid dump filename', () => {
        const filename = generateDumpFilename()
        expect(filename).toMatch(/^dump_\d{8}-\d{6}\.sql$/)
    })

    it('should generate a unique export ID', () => {
        const id1 = generateExportId()
        const id2 = generateExportId()
        expect(id1).toMatch(/^export_\d+_[a-z0-9]+$/)
        expect(id1).not.toBe(id2)
    })
})

describe('initializeExport', () => {
    it('should create an export state with all tables', async () => {
        vi.mocked(executeOperation).mockResolvedValueOnce([
            { name: 'users' },
            { name: 'orders' },
        ])

        const state = await initializeExport(
            mockDataSource,
            mockConfig,
            mockR2Bucket
        )

        expect(state.status).toBe('processing')
        expect(state.tables).toEqual(['users', 'orders'])
        expect(state.currentTableIndex).toBe(0)
        expect(state.currentRowOffset).toBe(0)
        expect(state.r2Key).toMatch(/^dump_\d{8}-\d{6}\.sql$/)
        expect(mockR2Bucket.put).toHaveBeenCalledOnce()
    })

    it('should exclude tmp_ tables from export', async () => {
        vi.mocked(executeOperation).mockResolvedValueOnce([{ name: 'users' }])

        const state = await initializeExport(
            mockDataSource,
            mockConfig,
            mockR2Bucket
        )

        // The SQL query itself filters tmp_ tables
        expect(executeOperation).toHaveBeenCalledWith(
            [
                {
                    sql: "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'tmp_%';",
                },
            ],
            mockDataSource,
            mockConfig
        )
        expect(state.tables).toEqual(['users'])
    })

    it('should handle empty database', async () => {
        vi.mocked(executeOperation).mockResolvedValueOnce([])

        const state = await initializeExport(
            mockDataSource,
            mockConfig,
            mockR2Bucket
        )

        expect(state.tables).toEqual([])
        expect(state.status).toBe('processing')
    })

    it('should store callbackUrl when provided', async () => {
        vi.mocked(executeOperation).mockResolvedValueOnce([])

        const state = await initializeExport(
            mockDataSource,
            mockConfig,
            mockR2Bucket,
            'https://example.com/callback'
        )

        expect(state.callbackUrl).toBe('https://example.com/callback')
    })
})

describe('processExportChunk', () => {
    it('should process all tables and mark as completed for small DB', async () => {
        const state: ExportState = {
            exportId: 'test-export',
            status: 'processing',
            tables: ['users'],
            currentTableIndex: 0,
            currentRowOffset: 0,
            currentTableSchemaWritten: false,
            r2Key: 'dump_test.sql',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            totalRowsExported: 0,
        }

        // Schema query
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([
                { sql: 'CREATE TABLE users (id INTEGER, name TEXT);' },
            ])
            // Data batch (less than BATCH_SIZE means table is exhausted)
            .mockResolvedValueOnce([
                { id: 1, name: 'Alice' },
                { id: 2, name: 'Bob' },
            ])

        const updatedState = await processExportChunk(
            state,
            mockDataSource,
            mockConfig,
            mockR2Bucket
        )

        expect(updatedState.status).toBe('completed')
        expect(updatedState.totalRowsExported).toBe(2)
        expect(mockR2Bucket.put).toHaveBeenCalled()

        // Verify the content written to R2 includes the data
        const putCall = mockR2Bucket.put.mock.calls[0]
        expect(putCall[1]).toContain('CREATE TABLE users')
        expect(putCall[1]).toContain(
            'INSERT INTO "users" VALUES (1, \'Alice\');'
        )
        expect(putCall[1]).toContain('INSERT INTO "users" VALUES (2, \'Bob\');')
    })

    it('should handle NULL values in rows', async () => {
        const state: ExportState = {
            exportId: 'test-export',
            status: 'processing',
            tables: ['users'],
            currentTableIndex: 0,
            currentRowOffset: 0,
            currentTableSchemaWritten: false,
            r2Key: 'dump_test.sql',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            totalRowsExported: 0,
        }

        vi.mocked(executeOperation)
            .mockResolvedValueOnce([
                { sql: 'CREATE TABLE users (id INTEGER, name TEXT);' },
            ])
            .mockResolvedValueOnce([{ id: 1, name: null }])

        const updatedState = await processExportChunk(
            state,
            mockDataSource,
            mockConfig,
            mockR2Bucket
        )

        expect(updatedState.status).toBe('completed')
        const putCall = mockR2Bucket.put.mock.calls[0]
        expect(putCall[1]).toContain('INSERT INTO "users" VALUES (1, NULL);')
    })

    it('should mark as failed on error', async () => {
        const state: ExportState = {
            exportId: 'test-export',
            status: 'processing',
            tables: ['users'],
            currentTableIndex: 0,
            currentRowOffset: 0,
            currentTableSchemaWritten: false,
            r2Key: 'dump_test.sql',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            totalRowsExported: 0,
        }

        mockR2Bucket.get = vi
            .fn()
            .mockRejectedValue(new Error('R2 unavailable'))

        const updatedState = await processExportChunk(
            state,
            mockDataSource,
            mockConfig,
            mockR2Bucket
        )

        expect(updatedState.status).toBe('failed')
        expect(updatedState.error).toContain('R2 unavailable')
    })

    it('should fire callback on completion', async () => {
        const fetchSpy = vi
            .spyOn(global, 'fetch')
            .mockResolvedValue(new Response('ok'))

        const state: ExportState = {
            exportId: 'test-export',
            status: 'processing',
            tables: [],
            currentTableIndex: 0,
            currentRowOffset: 0,
            currentTableSchemaWritten: false,
            r2Key: 'dump_test.sql',
            callbackUrl: 'https://example.com/callback',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            totalRowsExported: 0,
        }

        const updatedState = await processExportChunk(
            state,
            mockDataSource,
            mockConfig,
            mockR2Bucket
        )

        expect(updatedState.status).toBe('completed')
        expect(fetchSpy).toHaveBeenCalledWith(
            'https://example.com/callback',
            expect.objectContaining({
                method: 'POST',
                body: expect.stringContaining('"status":"completed"'),
            })
        )

        fetchSpy.mockRestore()
    })
})

describe('exportStatusRoute', () => {
    it('should return 404 for unknown export', async () => {
        const response = await exportStatusRoute('unknown-id', async () => null)
        expect(response.status).toBe(404)
    })

    it('should return export state for known export', async () => {
        const state: ExportState = {
            exportId: 'test-export',
            status: 'processing',
            tables: ['users', 'orders'],
            currentTableIndex: 1,
            currentRowOffset: 500,
            currentTableSchemaWritten: true,
            r2Key: 'dump_test.sql',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            totalRowsExported: 1500,
        }

        const response = await exportStatusRoute(
            'test-export',
            async () => state
        )
        expect(response.status).toBe(200)

        const body = await response.json()
        expect(body.result.exportId).toBe('test-export')
        expect(body.result.status).toBe('processing')
        expect(body.result.totalRowsExported).toBe(1500)
        expect(body.result.tablesProcessed).toBe(1)
        expect(body.result.tablesTotal).toBe(2)
    })
})

describe('exportDownloadRoute', () => {
    it('should return 404 for unknown export', async () => {
        const response = await exportDownloadRoute(
            'unknown-id',
            mockR2Bucket,
            async () => null
        )
        expect(response.status).toBe(404)
    })

    it('should return 202 for in-progress export', async () => {
        const state: ExportState = {
            exportId: 'test-export',
            status: 'processing',
            tables: ['users'],
            currentTableIndex: 0,
            currentRowOffset: 0,
            currentTableSchemaWritten: false,
            r2Key: 'dump_test.sql',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            totalRowsExported: 0,
        }

        const response = await exportDownloadRoute(
            'test-export',
            mockR2Bucket,
            async () => state
        )
        expect(response.status).toBe(202)
    })

    it('should return file for completed export', async () => {
        const state: ExportState = {
            exportId: 'test-export',
            status: 'completed',
            tables: ['users'],
            currentTableIndex: 1,
            currentRowOffset: 0,
            currentTableSchemaWritten: false,
            r2Key: 'dump_test.sql',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            totalRowsExported: 10,
        }

        const response = await exportDownloadRoute(
            'test-export',
            mockR2Bucket,
            async () => state
        )

        expect(response.headers.get('Content-Type')).toBe('application/sql')
        expect(response.headers.get('Content-Disposition')).toContain(
            'dump_test.sql'
        )
    })
})
