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

    mockDataSource = {
        source: 'internal',
        rpc: { executeQuery: vi.fn() },
    } as unknown as DataSource

    mockConfig = {
        outerbaseApiKey: 'mock-api-key',
        role: 'admin',
        features: { allowlist: true, rls: true, rest: true },
    }
})

describe('CSV Import Module - importTableFromCsvRoute', () => {
    it('should return 400 when request body is empty', async () => {
        const request = new Request('http://localhost/import/csv/users', {
            method: 'POST',
        })

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(400)
        const json = (await response.json()) as { error?: string }
        expect(json.error).toBe('Request body is empty')
    })

    it('should return 400 for unsupported Content-Type', async () => {
        const request = new Request('http://localhost/import/csv/users', {
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
        const json = (await response.json()) as { error?: string }
        expect(json.error).toBe('Unsupported Content-Type')
    })

    it('should return 400 when CSV contains only header and no data rows', async () => {
        const request = new Request('http://localhost/import/csv/users', {
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
        const json = (await response.json()) as { error?: string }
        expect(json.error).toBe('Invalid CSV format or empty data')
    })

    it('should import raw text/csv body into the target table', async () => {
        vi.mocked(executeOperation).mockResolvedValue([])

        const request = new Request('http://localhost/import/csv/users', {
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
        const json = (await response.json()) as { result: { message: string } }
        expect(json.result.message).toBe(
            'Imported 2 out of 2 records successfully. 0 records failed.'
        )
        expect(executeOperation).toHaveBeenCalledTimes(2)
    })

    it('should import JSON-wrapped CSV data with columnMapping', async () => {
        vi.mocked(executeOperation).mockResolvedValue([])

        const request = new Request('http://localhost/import/csv/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                data: 'user_id,full_name\n10,Charlie',
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
                    params: ['10', 'Charlie'],
                },
            ],
            mockDataSource,
            mockConfig
        )
    })

    it('should return 400 when multipart/form-data has no file', async () => {
        const formData = new FormData()
        const request = new Request('http://localhost/import/csv/users', {
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
        const json = (await response.json()) as { error?: string }
        expect(json.error).toBe('No file uploaded')
    })

    it('should record failed statements when executeOperation rejects for a row', async () => {
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([])
            .mockRejectedValueOnce(new Error('Unique constraint failed'))

        const request = new Request('http://localhost/import/csv/users', {
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
        const json = (await response.json()) as {
            result: { message: string; failedStatements: any[] }
        }
        expect(json.result.message).toBe(
            'Imported 1 out of 2 records successfully. 1 records failed.'
        )
        expect(json.result.failedStatements).toHaveLength(1)
    })
})
