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
    vi.spyOn(console, 'error').mockImplementation(() => {})

    mockDataSource = {
        source: 'internal',
        external: { dialect: 'sqlite' },
        rpc: { executeQuery: vi.fn() },
    } as any

    mockConfig = {
        outerbaseApiKey: 'mock-api-key',
        role: 'admin',
        features: { allowlist: true, rls: true, rest: true, import: true },
    }
})

async function readBody(response: Response) {
    return (await response.json()) as { result?: any; error?: string }
}

describe('CSV Import Module', () => {
    it('returns 400 when the request body is empty', async () => {
        const request = new Request('http://localhost/import/csv/users', {
            method: 'POST',
            headers: { 'Content-Type': 'text/csv' },
        })

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(400)
        expect((await readBody(response)).error).toBe('Request body is empty')
    })

    it('returns 400 for an unsupported Content-Type', async () => {
        const request = new Request('http://localhost/import/csv/users', {
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
        expect((await readBody(response)).error).toBe(
            'Unsupported Content-Type'
        )
    })

    it('returns 400 when multipart form-data has no file', async () => {
        const request = new Request('http://localhost/import/csv/users', {
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
        expect((await readBody(response)).error).toBe('No file uploaded')
    })

    it('returns 400 for header-only or empty CSV data', async () => {
        const request = new Request('http://localhost/import/csv/users', {
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
        expect((await readBody(response)).error).toBe(
            'Invalid CSV format or empty data'
        )
    })

    it('imports raw text/csv rows into a real table', async () => {
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
        expect((await readBody(response)).result.message).toBe(
            'Imported 2 out of 2 records successfully. 0 records failed.'
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

    it('imports JSON-wrapped CSV and applies column mapping', async () => {
        vi.mocked(executeOperation).mockResolvedValue([])

        const request = new Request('http://localhost/import/csv/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                data: 'user_id,full_name\n9,Carol',
                columnMapping: {
                    user_id: 'id',
                    full_name: 'name',
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
                    sql: 'INSERT INTO users (id, name) VALUES (?, ?)',
                    params: ['9', 'Carol'],
                },
            ],
            mockDataSource,
            mockConfig
        )
    })

    it('imports a multipart CSV file upload', async () => {
        vi.mocked(executeOperation).mockResolvedValue([])
        const formData = new FormData()
        formData.append(
            'file',
            new File(['id,name\n3,Dana'], 'users.csv', { type: 'text/csv' })
        )

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

        expect(response.status).toBe(200)
        expect((await readBody(response)).result.message).toContain(
            'Imported 1 out of 1'
        )
    })

    it('skips malformed rows that do not match the header width', async () => {
        vi.mocked(executeOperation).mockResolvedValue([])

        const request = new Request('http://localhost/import/csv/users', {
            method: 'POST',
            headers: { 'Content-Type': 'text/csv' },
            body: 'id,name\n1,Alice\nbroken-row\n2,Bob',
        })

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(200)
        expect(executeOperation).toHaveBeenCalledTimes(2)
        expect((await readBody(response)).result.message).toBe(
            'Imported 2 out of 2 records successfully. 0 records failed.'
        )
    })

    it('reports partial insert failures without aborting the batch', async () => {
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([])
            .mockRejectedValueOnce(new Error('UNIQUE constraint failed'))

        const request = new Request('http://localhost/import/csv/users', {
            method: 'POST',
            headers: { 'Content-Type': 'text/csv' },
            body: 'id,name\n1,Alice\n1,Alice-dup',
        })

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        const body = await readBody(response)
        expect(response.status).toBe(200)
        expect(body.result.message).toBe(
            'Imported 1 out of 2 records successfully. 1 records failed.'
        )
        expect(body.result.failedStatements).toHaveLength(1)
        expect(body.result.failedStatements[0].error).toBe(
            'UNIQUE constraint failed'
        )
    })

    it('returns 500 when the JSON-wrapped payload cannot be parsed', async () => {
        const request = new Request('http://localhost/import/csv/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{not-json',
        })

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(500)
        expect((await readBody(response)).error).toContain(
            'Failed to import CSV data'
        )
    })

    it('does not invent a table when the table name is empty', async () => {
        vi.mocked(executeOperation).mockResolvedValue([])

        const request = new Request('http://localhost/import/csv/', {
            method: 'POST',
            headers: { 'Content-Type': 'text/csv' },
            body: 'id,name\n1,Alice',
        })

        const response = await importTableFromCsvRoute(
            '',
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(200)
        expect(executeOperation).toHaveBeenCalledWith(
            [
                {
                    sql: 'INSERT INTO  (id, name) VALUES (?, ?)',
                    params: ['1', 'Alice'],
                },
            ],
            mockDataSource,
            mockConfig
        )
    })
})
