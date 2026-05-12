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
    it('should import raw CSV data from a text/csv request', async () => {
        vi.mocked(executeOperation).mockResolvedValue({} as any)

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
        expect(executeOperation).toHaveBeenNthCalledWith(
            2,
            [
                {
                    sql: 'INSERT INTO users (id, name) VALUES (?, ?)',
                    params: ['2', 'Bob'],
                },
            ],
            mockDataSource,
            mockConfig
        )

        const jsonResponse = (await response.json()) as {
            result: { message: string; failedStatements: unknown[] }
        }
        expect(jsonResponse.result.message).toBe(
            'Imported 2 out of 2 records successfully. 0 records failed.'
        )
        expect(jsonResponse.result.failedStatements).toEqual([])
    })

    it('should apply column mappings from a JSON-wrapped CSV request', async () => {
        vi.mocked(executeOperation).mockResolvedValue({} as any)

        const request = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                data: 'Email Address,Display Name\nalice@example.com,Alice',
                columnMapping: {
                    'Email Address': 'email',
                    'Display Name': 'name',
                },
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
                    sql: 'INSERT INTO users (email, name) VALUES (?, ?)',
                    params: ['alice@example.com', 'Alice'],
                },
            ],
            mockDataSource,
            mockConfig
        )
    })

    it('should import CSV data from a multipart file upload', async () => {
        vi.mocked(executeOperation).mockResolvedValue({} as any)

        const formData = new FormData()
        formData.append(
            'file',
            new File(['id,name\n1,Alice'], 'users.csv', { type: 'text/csv' })
        )

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

    it('should report partial success when some CSV rows fail to insert', async () => {
        vi.mocked(executeOperation)
            .mockResolvedValueOnce({} as any)
            .mockRejectedValueOnce(new Error('duplicate key'))

        const request = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'text/csv' },
            body: 'id,name\n1,Alice\n1,Alice Duplicate',
        })

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(200)
        const jsonResponse = (await response.json()) as {
            result: {
                message: string
                failedStatements: { statement: string; error: string }[]
            }
        }
        expect(jsonResponse.result.message).toBe(
            'Imported 1 out of 2 records successfully. 1 records failed.'
        )
        expect(jsonResponse.result.failedStatements).toEqual([
            {
                statement: 'INSERT INTO users (id, name) VALUES (?, ?)',
                error: 'duplicate key',
            },
        ])
    })

    it('should return 400 for unsupported content types', async () => {
        const request = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: 'id,name\n1,Alice',
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
        expect(executeOperation).not.toHaveBeenCalled()
    })

    it('should return 400 when multipart form data has no file', async () => {
        const request = new Request('http://localhost', {
            method: 'POST',
            body: new FormData(),
        })

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(400)
        const jsonResponse = (await response.json()) as { error: string }
        expect(jsonResponse.error).toBe('No file uploaded')
        expect(executeOperation).not.toHaveBeenCalled()
    })

    it('should return 400 for CSV content without data rows', async () => {
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
        const jsonResponse = (await response.json()) as { error: string }
        expect(jsonResponse.error).toBe('Invalid CSV format or empty data')
        expect(executeOperation).not.toHaveBeenCalled()
    })
})
