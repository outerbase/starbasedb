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
        expect(createResponse).toHaveBeenCalledWith(
            undefined,
            'Request body is empty',
            400
        )
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
        expect(createResponse).toHaveBeenCalledWith(
            undefined,
            'Unsupported Content-Type',
            400
        )
    })

    it('should import CSV from application/json payload', async () => {
        const payload = {
            data: 'id,name\n1,Alice\n2,Bob',
        }
        const request = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        })

        vi.mocked(executeOperation).mockResolvedValue(undefined as any)

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(200)
        expect(executeOperation).toHaveBeenCalledTimes(2)
        expect(createResponse).toHaveBeenCalledWith(
            expect.objectContaining({
                message: 'Imported 2 out of 2 records successfully. 0 records failed.',
                failedStatements: [],
            }),
            undefined,
            200
        )
    })

    it('should import raw CSV from text/csv payload', async () => {
        const csvContent = 'id,name\n10,Charlie\n20,Dave'
        const request = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'text/csv' },
            body: csvContent,
        })

        vi.mocked(executeOperation).mockResolvedValue(undefined as any)

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(200)
        expect(executeOperation).toHaveBeenCalledTimes(2)
    })

    it('should handle multipart/form-data upload with file', async () => {
        const formData = new FormData()
        const blob = new Blob(['id,name\n100,Eve'], { type: 'text/csv' })
        formData.append('file', blob, 'test.csv')

        const request = new Request('http://localhost', {
            method: 'POST',
            body: formData,
        })

        vi.mocked(executeOperation).mockResolvedValue(undefined as any)

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(200)
        expect(executeOperation).toHaveBeenCalledTimes(1)
    })

    it('should return 400 for multipart/form-data if file is missing', async () => {
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
        expect(createResponse).toHaveBeenCalledWith(
            undefined,
            'No file uploaded',
            400
        )
    })

    it('should return 400 if CSV data is empty or invalid header', async () => {
        const request = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'text/csv' },
            body: 'id,name\n',
        })

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(400)
        expect(createResponse).toHaveBeenCalledWith(
            undefined,
            'Invalid CSV format or empty data',
            400
        )
    })

    it('should apply columnMapping correctly', async () => {
        const payload = {
            data: 'external_id,full_name\n1,Alice',
            columnMapping: {
                external_id: 'id',
                full_name: 'name',
            },
        }
        const request = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        })

        vi.mocked(executeOperation).mockResolvedValue(undefined as any)

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

    it('should handle partial failures during batch import', async () => {
        const csvContent = 'id,name\n1,Good\n2,Bad'
        const request = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'text/csv' },
            body: csvContent,
        })

        vi.mocked(executeOperation)
            .mockResolvedValueOnce(undefined as any)
            .mockRejectedValueOnce(new Error('Duplicate primary key'))

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(200)
        expect(createResponse).toHaveBeenCalledWith(
            {
                message: 'Imported 1 out of 2 records successfully. 1 records failed.',
                failedStatements: [
                    {
                        statement: 'INSERT INTO users (id, name) VALUES (?, ?)',
                        error: 'Duplicate primary key',
                    },
                ],
            },
            undefined,
            200
        )
    })

    it('should catch unhandled errors and return 500', async () => {
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        const request = {
            body: true,
            headers: {
                get: () => {
                    throw new Error('Header failure')
                },
            },
        } as any

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(500)
        expect(createResponse).toHaveBeenCalledWith(
            undefined,
            'Failed to import CSV data: Header failure',
            500
        )
        consoleErrorSpy.mockRestore()
    })
})
