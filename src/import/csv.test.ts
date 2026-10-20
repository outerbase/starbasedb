import { describe, it, expect, vi, beforeEach } from 'vitest'
import { importTableFromCsvRoute } from './csv'
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
        features: { allowlist: true, rls: true, rest: true },
    }
})

describe('CSV Import Module', () => {
    it('should return 400 for empty request body', async () => {
        const request = new Request('http://localhost', {
            method: 'POST',
            body: null,
        })

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(400)
        const jsonResponse = (await response.json()) as { error?: string }
        expect(jsonResponse.error).toBe('Request body is empty')
    })

    it('should return 400 for unsupported Content-Type', async () => {
        const request = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'application/xml' },
            body: '<xml></xml>',
        })

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(400)
        const jsonResponse = (await response.json()) as { error?: string }
        expect(jsonResponse.error).toBe('Unsupported Content-Type')
    })

    it('should return 400 if multipart/form-data has no file', async () => {
        const formData = new FormData()

        const request = new Request('http://localhost', {
            method: 'POST',
            body: formData,
        })

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(400)
        const jsonResponse = (await response.json()) as { error?: string }
        expect(jsonResponse.error).toBe('No file uploaded')
    })

    it('should successfully parse and import raw text/csv data', async () => {
        vi.mocked(executeOperation).mockResolvedValue([])

        const csvContent = 'id,name\n1,Alice\n2,Bob'
        const request = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'text/csv' },
            body: csvContent,
        })

        const response = await importTableFromCsvRoute(
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
            'Imported 2 out of 2 records successfully. 0 records failed.'
        )
        expect(executeOperation).toHaveBeenCalledTimes(2)
        expect(executeOperation).toHaveBeenNthCalledWith(
            1,
            [
                {
                    sql: 'INSERT INTO users (id, name) VALUES (?, ?)',
                    params: ['1', 'Alice'],
                },
            ],
            mockDataSource,
            mockConfig
        )
    })

    it('should successfully import JSON-wrapped CSV data with column mapping', async () => {
        vi.mocked(executeOperation).mockResolvedValue([])

        const request = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                data: 'old_id,full_name\n10,Charlie',
                columnMapping: { old_id: 'id', full_name: 'name' },
            }),
        })

        const response = await importTableFromCsvRoute(
            'customers',
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(200)
        const jsonResponse = (await response.json()) as {
            result: { message: string }
        }
        expect(jsonResponse.result.message).toBe(
            'Imported 1 out of 1 records successfully. 0 records failed.'
        )
        expect(executeOperation).toHaveBeenCalledWith(
            [
                {
                    sql: 'INSERT INTO customers (id, name) VALUES (?, ?)',
                    params: ['10', 'Charlie'],
                },
            ],
            mockDataSource,
            mockConfig
        )
    })

    it('should successfully import CSV from multipart/form-data upload', async () => {
        vi.mocked(executeOperation).mockResolvedValue([])

        const formData = new FormData()
        const file = new File(['id,status\n100,active'], 'data.csv', {
            type: 'text/csv',
        })
        formData.append('file', file)

        const request = new Request('http://localhost', {
            method: 'POST',
            body: formData,
        })

        const response = await importTableFromCsvRoute(
            'items',
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(200)
        const jsonResponse = (await response.json()) as {
            result: { message: string }
        }
        expect(jsonResponse.result.message).toBe(
            'Imported 1 out of 1 records successfully. 0 records failed.'
        )
    })

    it('should return 400 for empty or invalid CSV data', async () => {
        const request = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'text/csv' },
            body: 'single_line_no_records',
        })

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(400)
        const jsonResponse = (await response.json()) as { error?: string }
        expect(jsonResponse.error).toBe('Invalid CSV format or empty data')
    })

    it('should handle partial failures when executeOperation fails for some records', async () => {
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([])
            .mockRejectedValueOnce(new Error('Unique constraint violated'))

        const csvContent = 'id,name\n1,Alice\n2,Duplicate'
        const request = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'text/csv' },
            body: csvContent,
        })

        const response = await importTableFromCsvRoute(
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
        expect(jsonResponse.result.failedStatements[0].error).toBe(
            'Unique constraint violated'
        )
    })

    it('should return 500 when an unhandled exception occurs', async () => {
        const request = {
            body: true,
            headers: {
                get: () => {
                    throw new Error('Fatal header parsing error')
                },
            },
        } as unknown as Request

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(500)
        const jsonResponse = (await response.json()) as { error?: string }
        expect(jsonResponse.error).toContain('Failed to import CSV data')
    })
})
