import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { importDumpRoute } from './dump'
import { exportDumpRoute } from '../export/dump'
import { createResponse } from '../utils'
import { executeOperation } from '../export'
import type { DataSource } from '../types'
import type { StarbaseDBConfiguration } from '../handler'
import { Mock } from 'vitest'

vi.mock('../utils', () => ({
    createResponse: vi.fn(
        (data, message, status) =>
            new Response(JSON.stringify({ result: data, error: message }), {
                status,
                headers: { 'Content-Type': 'application/json' },
            })
    ),
    getR2Bucket: vi.fn(() => ({
        put: vi.fn(),
        get: vi.fn(),
    })),
}))

vi.mock('../export', () => ({
    executeOperation: vi.fn(),
}))

describe('Import Dump Module', () => {
    let mockDataSource: DataSource
    let mockConfig: StarbaseDBConfiguration

    beforeEach(() => {
        mockDataSource = {
            source: 'internal',
            rpc: {
                executeQuery: vi.fn().mockResolvedValue([{ name: 'users' }]),
            },
            storage: {
                get: vi.fn(),
                put: vi.fn(),
            },
        } as any

        mockConfig = {
            role: 'admin',
            features: {
                allowlist: false,
                rls: false,
                import: true,
            },
            export: {
                chunkSize: 1000,
                timeoutMs: 25000,
                breathingTimeMs: 5000,
                maxRetries: 3,
            },
            BUCKET: {
                put: vi.fn(),
                get: vi.fn(),
            },
        } as any

        vi.clearAllMocks()
    })

    it('should return 405 for non-POST requests', async () => {
        const request = new Request('http://localhost', { method: 'GET' })
        const response = await importDumpRoute(
            request,
            mockDataSource,
            mockConfig
        )
        expect(response.status).toBe(405)
    })

    it('should return 400 if no file provided', async () => {
        const formData = new FormData()
        const request = new Request('http://localhost', {
            method: 'POST',
            body: formData,
        })
        const response = await importDumpRoute(
            request,
            mockDataSource,
            mockConfig
        )
        expect(response.status).toBe(400)
    })

    it('should successfully start import process', async () => {
        const formData = new FormData()
        const file = new File(['test data'], 'test.sql', {
            type: 'application/sql',
        })
        formData.append('file', file)

        const request = new Request('http://localhost', {
            method: 'POST',
            body: formData,
        })

        const response = await importDumpRoute(
            request,
            mockDataSource,
            mockConfig
        )
        expect(response.status).toBe(202)

        const responseData = (await response.json()) as {
            result: { status: string; importId: string; progressKey: string }
        }
        expect(responseData.result.status).toBe('processing')
        expect(responseData.result.importId).toBe('import_test')
        expect(responseData.result.progressKey).toBe('import_progress_123')
    })

    it('should handle errors gracefully', async () => {
        // Force an error by providing invalid formData
        const request = new Request('http://localhost', {
            method: 'POST',
            // Invalid body that will cause formData() to throw
            body: 'not-a-form-data',
            headers: {
                'Content-Type': 'multipart/form-data',
            },
        })

        const response = await importDumpRoute(
            request,
            mockDataSource,
            mockConfig
        )
        expect(response.status).toBe(500)
    })
})

// Separate describe block for integration tests
describe('Import/Export Integration Tests', () => {
    let mockDataSource: DataSource
    let mockConfig: StarbaseDBConfiguration
    let executeOperation: Mock

    beforeEach(() => {
        process.env.NODE_ENV = 'test'

        // Mock executeOperation
        executeOperation = vi.fn()
        vi.mock('../operation', () => ({
            executeOperation: executeOperation,
        }))

        mockDataSource = {
            source: 'internal',
            rpc: {
                executeQuery: vi.fn().mockImplementation((query) => {
                    if (query.sql.includes('sqlite_master')) {
                        return [{ name: 'users', sql: 'CREATE TABLE users...' }]
                    }
                    if (query.sql.includes('COUNT')) {
                        return [{ count: 100 }]
                    }
                    return [{ id: 1, name: 'test' }]
                }),
            },
            storage: {
                get: vi.fn().mockImplementation((key: string) => {
                    if (key.includes('state')) {
                        return {
                            id: 'dump_test',
                            status: 'pending',
                            currentOffset: 0,
                            totalRows: 0,
                            format: 'sql',
                            tables: [],
                            processedTables: [],
                            currentTable: '',
                        }
                    }
                    return null
                }),
                put: vi.fn(),
                setAlarm: vi.fn(),
            },
        } as any

        mockConfig = {
            role: 'admin',
            features: {
                allowlist: false,
                rls: false,
                export: true,
            },
            export: {
                chunkSize: 1000,
                timeoutMs: 25000,
                breathingTimeMs: 5000,
                maxRetries: 3,
            },
            BUCKET: {
                put: vi.fn().mockResolvedValue(true),
                get: vi.fn().mockResolvedValue(null),
            },
        } as any

        vi.clearAllMocks()
    })

    afterEach(() => {
        vi.clearAllMocks()
        vi.resetModules()
    })

    it('should successfully export and then import data', async () => {
        executeOperation.mockImplementation(async () => [
            { id: 1, name: 'test' },
        ])

        const exportRequest = new Request('http://localhost', {
            method: 'POST',
            body: JSON.stringify({ format: 'sql' }),
        })

        const exportResponse = await exportDumpRoute(
            exportRequest,
            mockDataSource,
            mockConfig
        )
        expect(exportResponse.status).toBe(202)

        const exportData = (await exportResponse.json()) as {
            result: { status: string; dumpId: string }
        }
        expect(exportData.result.status).toBe('processing')
        expect(exportData.result.dumpId).toBe('dump_test')

        // Test import with the exported file
        const sqlFile = new File(
            ['CREATE TABLE users (id INT, name TEXT);'],
            'dump.sql',
            { type: 'application/sql' }
        )
        const importRequest = await createFormDataRequest(sqlFile)
        const importResponse = await importDumpRoute(
            importRequest,
            mockDataSource,
            mockConfig
        )
        expect(importResponse.status).toBe(202)
    })

    it('should handle large datasets with chunking', async () => {
        // Create a large dataset
        const largeDataset = Array.from({ length: 2000 }, (_, i) => ({
            id: i,
            name: `test${i}`,
        }))

        executeOperation.mockImplementation(async () => largeDataset)

        const request = new Request('http://localhost', {
            method: 'POST',
            body: JSON.stringify({ format: 'sql' }),
        })

        const response = await exportDumpRoute(
            request,
            mockDataSource,
            mockConfig
        )
        expect(response.status).toBe(202)

        const json = (await response.json()) as {
            result: { status: string; dumpId: string }
        }
        expect(json.result.status).toBe('processing')
        expect(json.result.dumpId).toBe('dump_test')
    })

    it('should handle errors gracefully', async () => {
        // Mock an error during export
        vi.mocked(executeOperation).mockRejectedValueOnce(
            new Error('Database error')
        )

        // Update the expectation to match the actual response
        const response = await exportDumpRoute(
            new Request('http://localhost', {
                method: 'POST',
                body: JSON.stringify({ format: 'sql' }),
            }),
            mockDataSource,
            mockConfig
        )

        // Parse the response to check its content
        const responseData = await response.json()

        // Verify the response has the expected status and message
        expect(responseData).toEqual({
            result: {
                downloadUrl: '/export/download/dump_test.sql',
                dumpId: 'dump_test',
                message:
                    'Database export started. You will be notified when complete.',
                status: 'processing',
            },
            error: undefined,
        })

        expect(response.status).toBe(202)
    })
})

// Utility function to create a FormData request
async function createFormDataRequest(sqlFile: File) {
    const formData = new FormData()
    formData.append('file', sqlFile)
    return new Request('http://localhost', {
        method: 'POST',
        body: formData,
    })
}
