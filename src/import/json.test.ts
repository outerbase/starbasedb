import { describe, it, expect, vi, beforeEach } from 'vitest'
import { importTableFromJsonRoute } from './json'
import { executeOperation } from '../export'
import { createResponse } from '../utils'
import type { DataSource } from '../types'
import type { StarbaseDBConfiguration } from '../handler'

vi.mock('../export', () => ({
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

beforeEach(() => {
    vi.clearAllMocks()

    mockDataSource = {
        source: 'external',
        external: { dialect: 'sqlite' },
        rpc: { executeQuery: vi.fn() },
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
        BUCKET: null,
    }
})

describe('JSON Import Module', () => {
    it('should return 400 for unsupported Content-Type', async () => {
        const request = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: 'Invalid body',
        })

        const response = await importTableFromJsonRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(400)
        const jsonResponse = (await response.json()) as {
            error?: string
            result?: any
        }
        expect(jsonResponse.error).toBe('Unsupported Content-Type')
    })

    it('should return 400 if JSON format is invalid', async () => {
        const request = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: 'Invalid JSON',
        })

        const response = await importTableFromJsonRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(400)
        const jsonResponse = (await response.json()) as {
            error?: string
            result?: any
        }
        expect(jsonResponse.error).toContain('Invalid JSON format')
    })

    it('should return 400 if no file is uploaded in multipart form-data', async () => {
        const formData = new FormData()

        const request = new Request('http://localhost', {
            method: 'POST',
            body: formData,
        })

        const response = await importTableFromJsonRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(400)
        const jsonResponse = (await response.json()) as {
            error?: string
            result?: any
        }
        expect(jsonResponse.error).toBe('No file uploaded')
    })

    it('should successfully insert valid JSON data into the table', async () => {
        vi.mocked(executeOperation).mockResolvedValue([])

        const request = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                data: [
                    { id: 1, name: 'Alice' },
                    { id: 2, name: 'Bob' },
                ],
            }),
        })

        const response = await importTableFromJsonRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(200)
        const jsonResponse = (await response.json()) as {
            result: { message: string }
        }
        expect(jsonResponse.result.message).toBe(
            'Imported 2 out of 2 records successfully. 0 records failed.'
        )
    })

    it('should return partial success if some inserts fail', async () => {
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([])
            .mockRejectedValueOnce(new Error('Database Error'))

        const request = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                data: [
                    { id: 1, name: 'Alice' },
                    { id: 2, name: 'Bob' },
                ],
            }),
        })

        const response = await importTableFromJsonRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(200)
        const jsonResponse = (await response.json()) as {
            result: { message: string; failedStatements: any[] }
        }
        expect(jsonResponse.result.message).toBe(
            'Imported 1 out of 2 records successfully. 1 records failed.'
        )
        expect(jsonResponse.result.failedStatements.length).toBe(1)
    })

    it('should return 500 if an internal error occurs', async () => {
        vi.mocked(executeOperation).mockRejectedValue(
            new Error('Unexpected Error')
        )
        const request = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: [{ id: 1, name: 'Alice' }] }),
        })

        const response = await importTableFromJsonRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(500)
        const jsonResponse = (await response.json()) as {
            error?: string
            result?: any
        }
        expect(jsonResponse.error).toBe('Failed to import JSON data')
    })
})
