import { describe, it, expect, vi, beforeEach } from 'vitest'
import { exportDumpRoute } from './dump'
import { executeOperation } from '../export'
import { createResponse } from '../utils'
import type { DataSource } from '../types'
import type { StarbaseDBConfiguration } from '../types'

vi.mock('../export', () => ({
    executeOperation: vi.fn(),
}))

vi.mock('../utils', () => ({
    createResponse: vi
        .fn()
        .mockImplementation(
            (data, message, status) =>
                new Response(JSON.stringify({ result: data, error: message }), {
                    status,
                })
        ),
    getR2Bucket: vi.fn().mockReturnValue({
        put: vi.fn().mockResolvedValue({}),
        get: vi.fn().mockResolvedValue(new Response('test data')),
    }),
}))

describe('Database Export Module', () => {
    let mockDataSource: DataSource
    let mockConfig: StarbaseDBConfiguration
    let mockRequest: Request

    beforeEach(() => {
        vi.clearAllMocks()

        mockDataSource = {
            source: 'internal',
            rpc: { executeQuery: vi.fn() },
            storage: {
                get: vi.fn(),
                put: vi.fn(),
                setAlarm: vi.fn(),
            },
        } as any

        mockConfig = {
            outerbaseApiKey: 'mock-api-key',
            role: 'admin',
            features: {
                allowlist: true,
                rls: true,
                rest: true,
                export: true,
                import: true,
            },
            BUCKET: {
                put: vi.fn().mockResolvedValue({}),
                get: vi.fn().mockResolvedValue(new Response('test data')),
            },
        }

        // Create a mock request
        mockRequest = new Request('http://localhost/export', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ format: 'sql' }),
        })
    })

    it('should start a database export process', async () => {
        // Mock successful responses
        vi.mocked(mockDataSource.storage.get).mockResolvedValue(null)
        vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValue([
            {
                name: 'users',
                sql: 'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)',
            },
        ])

        const response = await exportDumpRoute(
            mockRequest,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(202)
        const data = (await response.json()) as {
            result: { status: string; dumpId: string; downloadUrl: string }
        }
        expect(data.result).toHaveProperty('status', 'processing')
    })

    it('should handle errors gracefully', async () => {
        // Mock an error during export
        vi.mocked(mockDataSource.rpc.executeQuery).mockRejectedValue(
            new Error('Database error')
        )

        // Temporarily mock console.error to suppress the error output
        const originalConsoleError = console.error
        console.error = vi.fn()

        try {
            const response = await exportDumpRoute(
                mockRequest,
                mockDataSource,
                mockConfig
            )
            expect(response.status).toBe(500)
        } finally {
            // Restore console.error
            console.error = originalConsoleError
        }
    })
})
