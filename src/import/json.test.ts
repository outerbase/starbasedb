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
        features: { allowlist: true, rls: true, rest: true },
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

    it.each([
        ['missing data', {}],
        ['null data', { data: null }],
        ['object data', { data: { id: 1, name: 'Alice' } }],
    ])(
        'should return 400 without inserts for application/json with %s',
        async (_caseName, payload) => {
            const request = new Request('http://localhost', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            })

            const response = await importTableFromJsonRoute(
                'users',
                request,
                mockDataSource,
                mockConfig
            )

            expect(response.status).toBe(400)
            expect(executeOperation).not.toHaveBeenCalled()
            const jsonResponse = (await response.json()) as {
                error?: string
                result?: any
            }
            expect(jsonResponse.error).toBe(
                'Invalid JSON format. Expected an object with "data" array and optional "columnMapping".'
            )
        }
    )

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

    it('should return 400 if uploaded JSON file is invalid', async () => {
        const formData = new FormData()
        formData.set(
            'file',
            new File(['not json'], 'users.json', {
                type: 'application/json',
            })
        )

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
        expect(executeOperation).not.toHaveBeenCalled()
        const jsonResponse = (await response.json()) as {
            error?: string
            result?: any
        }
        expect(jsonResponse.error).toBe('Invalid file upload')
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

    it('should apply column mapping when inserting JSON records', async () => {
        vi.mocked(executeOperation).mockResolvedValue([])

        const request = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                data: [{ fullName: 'Alice', emailAddress: 'alice@test.dev' }],
                columnMapping: {
                    fullName: 'name',
                    emailAddress: 'email',
                },
            }),
        })

        const response = await importTableFromJsonRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(200)
        expect(executeOperation).toHaveBeenCalledWith(
            [
                {
                    sql: 'INSERT INTO users (name, email) VALUES (?, ?)',
                    params: ['Alice', 'alice@test.dev'],
                },
            ],
            mockDataSource,
            mockConfig
        )
    })

    it('should insert valid JSON data from multipart file upload', async () => {
        vi.mocked(executeOperation).mockResolvedValue([])

        const formData = new FormData()
        formData.set(
            'file',
            new File(
                [
                    JSON.stringify({
                        data: [{ id: 1, name: 'Alice' }],
                    }),
                ],
                'users.json',
                { type: 'application/json' }
            )
        )

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

        expect(response.status).toBe(200)
        expect(executeOperation).toHaveBeenCalledWith(
            [
                {
                    sql: 'INSERT INTO users (id, name) VALUES (?, ?)',
                    params: [1, 'Alice'],
                },
            ],
            mockDataSource,
            mockConfig
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
