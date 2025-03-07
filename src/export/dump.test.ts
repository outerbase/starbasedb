import { describe, it, expect, vi, beforeEach } from 'vitest'
import { exportDumpRoute } from './dump'
import { createResponse } from '../utils'
import type { DataSource } from '../types'
import type { StarbaseDBConfiguration } from '../handler'

vi.mock('../utils', () => ({
    createResponse: vi.fn(
        (data, message, status) =>
            new Response(JSON.stringify({ result: data, error: message }), {
                status,
                headers: { 'Content-Type': 'application/json' },
            })
    ),
}))

describe('Export Dump Module', () => {
    let mockDataSource: DataSource
    let mockConfig: StarbaseDBConfiguration

    beforeEach(() => {
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
                maxRetries: 3,
                breathingTimeMs: 5000,
            },
            BUCKET: {
                put: vi.fn().mockResolvedValue(true),
                get: vi.fn().mockResolvedValue(null),
            },
        } as any

        vi.clearAllMocks()
    })

    it('should return 405 for non-POST requests', async () => {
        const request = new Request('http://localhost', { method: 'GET' })
        const response = await exportDumpRoute(
            request,
            mockDataSource,
            mockConfig
        )
        expect(response.status).toBe(405)
    })

    it('should return 400 for invalid format', async () => {
        const request = new Request('http://localhost', {
            method: 'POST',
            body: JSON.stringify({ format: 'invalid' }),
        })
        const response = await exportDumpRoute(
            request,
            mockDataSource,
            mockConfig
        )
        expect(response.status).toBe(400)
    })

    it('should return 404 if no tables found', async () => {
        mockDataSource.rpc.executeQuery = vi
            .fn()
            .mockImplementation((query) => {
                if (query.sql.includes('sqlite_master')) {
                    return []
                }
                return [{ count: 0 }]
            })

        const request = new Request('http://localhost', {
            method: 'POST',
            body: JSON.stringify({ format: 'sql' }),
        })
        const response = await exportDumpRoute(
            request,
            mockDataSource,
            mockConfig
        )
        expect(response.status).toBe(404)
        const data = (await response.json()) as { error: string }
        expect(data.error).toBe('No tables found')
    })

    it('should successfully export database in chunks', async () => {
        mockDataSource.rpc.executeQuery = vi
            .fn()
            .mockResolvedValueOnce([{ name: 'users' }, { name: 'posts' }])

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

        const responseData = (await response.json()) as {
            result: { status: string; dumpId: string }
        }
        expect(responseData.result.status).toBe('processing')
        expect(responseData.result.dumpId).toBe('dump_test')
    })

    it('should handle errors gracefully', async () => {
        mockDataSource.rpc.executeQuery = vi
            .fn()
            .mockRejectedValue(new Error('Database error'))

        const request = new Request('http://localhost', {
            method: 'POST',
            body: JSON.stringify({ format: 'sql' }),
        })

        const response = await exportDumpRoute(
            request,
            mockDataSource,
            mockConfig
        )
        expect(response.status).toBe(500)
        const data = (await response.json()) as { error: string }
        expect(data.error).toContain('Database error')
    })
})
