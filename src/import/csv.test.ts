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
        source: 'internal',
        rpc: { executeQuery: vi.fn() },
    } as any

    mockConfig = {
        outerbaseApiKey: 'mock-api-key',
        role: 'admin',
        features: { allowlist: true, rls: true, rest: true },
    }
})

describe('CSV Import Module (importTableFromCsvRoute)', () => {
    it('should return 400 if request body is empty', async () => {
        const request = new Request(
            'https://api.starbasedb.com/import/csv/users',
            {
                method: 'POST',
            }
        )

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(400)
        const body = (await response.json()) as any
        expect(body.error).toBe('Request body is empty')
    })

    it('should return 400 for unsupported content-type', async () => {
        const request = new Request(
            'https://api.starbasedb.com/import/csv/users',
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/xml' },
                body: '<xml></xml>',
            }
        )

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(400)
        const body = (await response.json()) as any
        expect(body.error).toBe('Unsupported Content-Type')
    })

    it('should import raw text/csv successfully', async () => {
        const csvContent = 'id,name\n1,Alice\n2,Bob'
        const request = new Request(
            'https://api.starbasedb.com/import/csv/users',
            {
                method: 'POST',
                headers: { 'Content-Type': 'text/csv' },
                body: csvContent,
            }
        )

        vi.mocked(executeOperation).mockResolvedValue([])

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(200)
        const body = (await response.json()) as any
        expect(body.result.message).toContain(
            'Imported 2 out of 2 records successfully'
        )
        expect(executeOperation).toHaveBeenCalledTimes(2)
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

    it('should import application/json wrapped CSV with column mapping', async () => {
        const payload = {
            data: 'emp_id,full_name\n101,John Doe',
            columnMapping: {
                emp_id: 'id',
                full_name: 'name',
            },
        }

        const request = new Request(
            'https://api.starbasedb.com/import/csv/users',
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            }
        )

        vi.mocked(executeOperation).mockResolvedValue([])

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(200)
        const body = (await response.json()) as any
        expect(body.result.message).toContain(
            'Imported 1 out of 1 records successfully'
        )
        expect(executeOperation).toHaveBeenCalledWith(
            [
                {
                    sql: 'INSERT INTO users (id, name) VALUES (?, ?)',
                    params: ['101', 'John Doe'],
                },
            ],
            mockDataSource,
            mockConfig
        )
    })

    it('should import multipart/form-data CSV file', async () => {
        const formData = new FormData()
        const file = new File(['id,name\n1,Charlie'], 'test.csv', {
            type: 'text/csv',
        })
        formData.append('file', file)

        const request = new Request(
            'https://api.starbasedb.com/import/csv/users',
            {
                method: 'POST',
                body: formData,
            }
        )

        vi.mocked(executeOperation).mockResolvedValue([])

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(200)
        const body = (await response.json()) as any
        expect(body.result.message).toContain(
            'Imported 1 out of 1 records successfully'
        )
    })

    it('should return 400 when multipart/form-data lacks a file', async () => {
        const formData = new FormData()
        formData.append('other_field', 'data')

        const request = new Request(
            'https://api.starbasedb.com/import/csv/users',
            {
                method: 'POST',
                body: formData,
            }
        )

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(400)
        const body = (await response.json()) as any
        expect(body.error).toBe('No file uploaded')
    })

    it('should return 400 when CSV has no data rows', async () => {
        const request = new Request(
            'https://api.starbasedb.com/import/csv/users',
            {
                method: 'POST',
                headers: { 'Content-Type': 'text/csv' },
                body: 'id,name\n',
            }
        )

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(400)
        const body = (await response.json()) as any
        expect(body.error).toBe('Invalid CSV format or empty data')
    })

    it('should report failed statements when executeOperation throws for a row', async () => {
        const csvContent = 'id,name\n1,Alice\n2,Bob'
        const request = new Request(
            'https://api.starbasedb.com/import/csv/users',
            {
                method: 'POST',
                headers: { 'Content-Type': 'text/csv' },
                body: csvContent,
            }
        )

        vi.mocked(executeOperation)
            .mockResolvedValueOnce([])
            .mockRejectedValueOnce(
                new Error('UNIQUE constraint failed: users.id')
            )

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(200)
        const body = (await response.json()) as any
        expect(body.result.message).toBe(
            'Imported 1 out of 2 records successfully. 1 records failed.'
        )
        expect(body.result.failedStatements.length).toBe(1)
        expect(body.result.failedStatements[0].error).toBe(
            'UNIQUE constraint failed: users.id'
        )
    })

    it('should return 500 when request body parsing throws an unhandled error', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        const request = {
            body: true,
            headers: {
                get: () => 'application/json',
            },
            json: () => Promise.reject(new Error('Malformed JSON payload')),
        } as any

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(500)
        const body = (await response.json()) as any
        expect(body.error).toContain('Failed to import CSV data')
    })
})
