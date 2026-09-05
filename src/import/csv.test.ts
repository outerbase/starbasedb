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
    it('should return 400 for unsupported Content-Type', async () => {
        const request = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: 'Invalid body',
        })

        const response = await importTableFromCsvRoute(
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

    it('should return 400 if request body is empty', async () => {
        const request = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'text/csv' },
            body: null,
        })

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(400)
        const jsonResponse = (await response.json()) as {
            error?: string
        }
        expect(jsonResponse.error).toBe('Request body is empty')
    })

    it('should return 400 if no file is uploaded in multipart form-data', async () => {
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
        const jsonResponse = (await response.json()) as {
            error?: string
        }
        expect(jsonResponse.error).toBe('No file uploaded')
    })

    it('should return 400 for empty CSV content', async () => {
        const request = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'text/csv' },
            body: '',
        })

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(400)
        const jsonResponse = (await response.json()) as {
            error?: string
        }
        expect(jsonResponse.error).toBe('Invalid CSV format or empty data')
    })

    it('should return 400 when only a header row is provided', async () => {
        const request = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'text/csv' },
            body: 'id,name',
        })

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(400)
        const jsonResponse = (await response.json()) as {
            error?: string
        }
        expect(jsonResponse.error).toBe('Invalid CSV format or empty data')
    })

    it('should successfully insert valid raw CSV data', async () => {
        vi.mocked(executeOperation).mockResolvedValue([])

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

        expect(response.status).toBe(200)
        const jsonResponse = (await response.json()) as {
            result: { message: string }
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

    it('should successfully insert JSON-wrapped CSV data with column mapping', async () => {
        vi.mocked(executeOperation).mockResolvedValue([])

        const request = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                data: 'user_id,full_name\n1,Alice',
                columnMapping: { user_id: 'id', full_name: 'name' },
            }),
        })

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(200)
        expect(executeOperation).toHaveBeenCalledWith(
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

    it('should successfully insert CSV data uploaded as multipart form-data', async () => {
        vi.mocked(executeOperation).mockResolvedValue([])

        const formData = new FormData()
        const file = new File(['id,name\n1,Alice'], 'data.csv', {
            type: 'text/csv',
        })
        formData.append('file', file)

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

        expect(response.status).toBe(200)
        const jsonResponse = (await response.json()) as {
            result: { message: string }
        }
        expect(jsonResponse.result.message).toBe(
            'Imported 1 out of 1 records successfully. 0 records failed.'
        )
    })

    it('should skip rows whose column count does not match the header', async () => {
        vi.mocked(executeOperation).mockResolvedValue([])

        const request = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'text/csv' },
            body: 'id,name\n1,Alice\n2,Bob,extra\n3',
        })

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(200)
        const jsonResponse = (await response.json()) as {
            result: { message: string }
        }
        // Only the well-formed "1,Alice" row matches the header's column count.
        expect(jsonResponse.result.message).toBe(
            'Imported 1 out of 1 records successfully. 0 records failed.'
        )
        expect(executeOperation).toHaveBeenCalledTimes(1)
    })

    it('should return partial success if some inserts fail', async () => {
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([])
            .mockRejectedValueOnce(new Error('Database Error'))

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

        expect(response.status).toBe(200)
        const jsonResponse = (await response.json()) as {
            result: { message: string; failedStatements: any[] }
        }
        expect(jsonResponse.result.message).toBe(
            'Imported 1 out of 2 records successfully. 1 records failed.'
        )
        expect(jsonResponse.result.failedStatements).toEqual([
            {
                statement: 'INSERT INTO users (id, name) VALUES (?, ?)',
                error: 'Database Error',
            },
        ])
    })

    it('should report all records as failed when every insert rejects', async () => {
        vi.mocked(executeOperation).mockRejectedValue(
            new Error('Unexpected Error')
        )

        const request = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'text/csv' },
            body: 'id,name\n1,Alice',
        })

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        // Per-record failures are caught inside the loop and reported back
        // with a 200, not surfaced as a 500 - only errors outside that loop
        // (e.g. malformed JSON) hit the outer catch.
        expect(response.status).toBe(200)
        const jsonResponse = (await response.json()) as {
            result: { message: string }
        }
        expect(jsonResponse.result.message).toBe(
            'Imported 0 out of 1 records successfully. 1 records failed.'
        )
    })

    it('should return 500 when JSON body cannot be parsed', async () => {
        const request = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: 'not valid json',
        })

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(500)
        const jsonResponse = (await response.json()) as {
            error?: string
        }
        expect(jsonResponse.error).toContain('Failed to import CSV data')
    })
})
