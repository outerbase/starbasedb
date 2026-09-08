import { describe, it, expect, vi, beforeEach } from 'vitest'
import { importTableFromCsvRoute } from './csv'
import { executeOperation } from '../export'
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
    ;(executeOperation as any).mockReset()

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

function jsonResponse(response: Response): Promise<{
    result?: any
    error?: string
}> {
    return response.json() as any
}

describe('CSV Import Module', () => {
    it('should return 400 for unsupported Content-Type', async () => {
        const request = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: 'id,name',
        })

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(400)
        expect((await jsonResponse(response)).error).toBe(
            'Unsupported Content-Type'
        )
    })

    it('should return 400 when request body is empty', async () => {
        const request = new Request('http://localhost/import', {
            method: 'GET',
        })

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(400)
        expect((await jsonResponse(response)).error).toBe(
            'Request body is empty'
        )
    })

    it('should import records from JSON-wrapped CSV data', async () => {
        ;(executeOperation as any).mockResolvedValue([])
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

        expect(response.status).toBe(200)
        const body = await jsonResponse(response)
        expect(body.result.message).toBe(
            'Imported 2 out of 2 records successfully. 0 records failed.'
        )
        expect(body.result.failedStatements).toEqual([])
        expect(executeOperation).toHaveBeenCalledTimes(2)
        const [operations] = (executeOperation as any).mock.calls[0]
        expect(operations[0].sql).toBe(
            'INSERT INTO users (id, name) VALUES (?, ?)'
        )
        expect(operations[0].params).toEqual(['1', 'Alice'])
    })

    it('should import raw CSV data with text/csv content type', async () => {
        ;(executeOperation as any).mockResolvedValue([])
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

        expect(response.status).toBe(200)
        expect(executeOperation).toHaveBeenCalledTimes(1)
    })

    it('should import CSV file uploaded via multipart form data', async () => {
        ;(executeOperation as any).mockResolvedValue([])
        const formData = new FormData()
        formData.append('file', new File(['id,name\n1,Alice'], 'data.csv'))

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
        expect(executeOperation).toHaveBeenCalledTimes(1)
    })

    it('should return 400 when multipart form has no file', async () => {
        const formData = new FormData()
        formData.append('notFile', 'nope')

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
        expect((await jsonResponse(response)).error).toBe('No file uploaded')
    })

    it('should return 400 for empty CSV data', async () => {
        const request = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: '' }),
        })

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(400)
        expect((await jsonResponse(response)).error).toBe(
            'Invalid CSV format or empty data'
        )
    })

    it('should skip rows whose column count does not match the header', async () => {
        ;(executeOperation as any).mockResolvedValue([])
        const request = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                data: 'id,name\n1,Alice,extra\n2,Bob',
            }),
        })

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(200)
        expect(executeOperation).toHaveBeenCalledTimes(1)
        const [operations] = (executeOperation as any).mock.calls[0]
        expect(operations[0].params).toEqual(['2', 'Bob'])
    })

    it('should apply column mapping to headers', async () => {
        ;(executeOperation as any).mockResolvedValue([])
        const request = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                data: 'id,name\n1,Alice',
                columnMapping: { name: 'full_name' },
            }),
        })

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(200)
        const [operations] = (executeOperation as any).mock.calls[0]
        expect(operations[0].sql).toBe(
            'INSERT INTO users (id, full_name) VALUES (?, ?)'
        )
        expect(operations[0].params).toEqual(['1', 'Alice'])
    })

    it('should report failed statements while importing the remaining records', async () => {
        ;(executeOperation as any)
            .mockRejectedValueOnce(new Error('UNIQUE constraint failed'))
            .mockResolvedValueOnce([])
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

        expect(response.status).toBe(200)
        const body = await jsonResponse(response)
        expect(body.result.message).toBe(
            'Imported 1 out of 2 records successfully. 1 records failed.'
        )
        expect(body.result.failedStatements).toEqual([
            {
                statement: 'INSERT INTO users (id, name) VALUES (?, ?)',
                error: 'UNIQUE constraint failed',
            },
        ])
    })

    it('should use a generic error message when the failure error has no message', async () => {
        ;(executeOperation as any).mockRejectedValue({})
        const request = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: 'id,name\n1,Alice' }),
        })

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(200)
        const body = await jsonResponse(response)
        expect(body.result.failedStatements[0].error).toBe('Unknown error')
    })

    it('should return 500 when parsing the request fails', async () => {
        const request = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: 'not json at all',
        })

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(500)
        expect((await jsonResponse(response)).error).toContain(
            'Failed to import CSV data'
        )
    })
})
