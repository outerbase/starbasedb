import { describe, it, expect, vi, beforeEach } from 'vitest'
import { importTableFromCsvRoute } from './csv'
import { executeOperation } from '../export'
import { createResponse } from '../utils'
import type { DataSource } from '../types'
import type { StarbaseDBConfiguration } from '../handler'
import FormData from 'form-data'

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
        source: 'internal',
        rpc: { executeQuery: vi.fn() },
    } as any

    mockConfig = {
        outerbaseApiKey: 'mock-api-key',
        role: 'admin',
        features: { allowlist: true, rls: true, rest: true },
    }
})

describe('CSV Import Module', () => {
    it('should import valid CSV data', async () => {
        vi.mocked(executeOperation).mockResolvedValueOnce([])

        const request = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'text/csv' },
            body: 'id,name\n1,Alice\n2,Bob',
        })

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        expect(executeOperation).toHaveBeenCalledTimes(2)
        expect(response.status).toBe(200)

        const jsonResponse = (await response.json()) as {
            result: { message: string }
            error: string
        }
        expect(jsonResponse.result.message).toContain(
            'Imported 2 out of 2 records successfully'
        )
    })

    it('should import JSON-wrapped CSV data', async () => {
        vi.mocked(executeOperation).mockResolvedValueOnce([])

        const request = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: 'id,name\n1,Alice\n2,Bob' }),
        })

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        expect(executeOperation).toHaveBeenCalledTimes(2)
        expect(response.status).toBe(200)

        const jsonResponse = (await response.json()) as unknown as {
            result: { message: string }
            error: string
        }
        expect(jsonResponse.result.message).toContain(
            'Imported 2 out of 2 records successfully'
        )
    })

    it('should handle CSV with column mapping', async () => {
        vi.mocked(executeOperation).mockResolvedValueOnce([])

        const request = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                data: 'id,full_name\n1,Alice Smith\n2,Bob Johnson',
                columnMapping: { full_name: 'name' },
            }),
        })

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        expect(executeOperation).toHaveBeenCalledTimes(2)
        expect(response.status).toBe(200)

        const jsonResponse = (await response.json()) as {
            result: { message: string }
            error: string
        }
        expect(jsonResponse.result.message).toContain(
            'Imported 2 out of 2 records successfully'
        )
    })

    it('should return an error if request body is empty', async () => {
        const request = new Request('http://localhost', {
            method: 'POST',
        })

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(400)

        const jsonResponse = (await response.json()) as { error: string }
        expect(jsonResponse.error).toBe('Request body is empty')
    })

    // it('should return an error if no file is uploaded in multipart/form-data', async () => {
    //     const formData = new FormData()

    //     const request = new Request('http://localhost', {
    //         method: 'POST',
    //         headers: { 'Content-Type': 'multipart/form-data' },
    //         body: formData as any,
    //     })

    //     const response = await importTableFromCsvRoute(
    //         'users',
    //         request,
    //         mockDataSource,
    //         mockConfig
    //     )

    //     expect(response.status).toBe(400)

    //     const jsonResponse = (await response.json()) as { error: string }
    //     expect(jsonResponse.error).toBe('No file uploaded')
    // })

    it('should return an error for unsupported content type', async () => {
        const request = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'application/xml' },
            body: '<xml><id>1</id></xml>',
        })

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(400)

        const jsonResponse = (await response.json()) as { error: string }
        expect(jsonResponse.error).toBe('Unsupported Content-Type')
    })
})
