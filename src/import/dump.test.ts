import { describe, it, expect, vi, beforeEach } from 'vitest'
import { importDumpRoute } from './dump'
import { createResponse } from '../utils'
import { executeOperation } from '../export'
import type { DataSource } from '../types'
import type { StarbaseDBConfiguration } from '../handler'

vi.mock('../utils', () => ({
    createResponse: vi.fn(
        (data, message, status) =>
            new Response(JSON.stringify({ result: data, error: message }), {
                status,
                headers: { 'Content-Type': 'application/json' },
            })
    ),
}))

vi.mock('../export', () => ({
    executeOperation: vi.fn(),
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

// Utility function to create a FormData request.
async function createFormDataRequest(sqlFile: File) {
    const formData = new FormData()
    formData.append('sqlFile', sqlFile)

    return new Request('http://localhost', {
        method: 'POST',
        body: formData,
    })
}

describe('Import Dump Module', () => {
    it('should reject non-POST requests', async () => {
        const request = new Request('http://localhost', { method: 'GET' })
        const response = await importDumpRoute(
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(405)
        const jsonResponse = (await response.json()) as { error: string }
        expect(jsonResponse.error).toBe('Method not allowed')
    })

    it('should reject requests with incorrect Content-Type', async () => {
        const request = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
        })
        const response = await importDumpRoute(
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(400)
        const jsonResponse = (await response.json()) as { error: string }
        expect(jsonResponse.error).toBe(
            'Content-Type must be multipart/form-data'
        )
    })

    it('should return 400 if no file is uploaded', async () => {
        const formData = new FormData()
        const request = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'form-data' },
            body: formData,
        })
        const response = await importDumpRoute(
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(400)
        const jsonResponse = (await response.json()) as { error: string }
        expect(jsonResponse.error).toBe(
            'Content-Type must be multipart/form-data'
        )
    })

    it('should return 400 if uploaded file is not a .sql file', async () => {
        const txtFile = new File(['SELECT * FROM users;'], 'data.txt', {
            type: 'text/plain',
        })

        const request = await createFormDataRequest(txtFile)

        const response = await importDumpRoute(
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(400)
        const jsonResponse = (await response.json()) as { error: string }
        expect(jsonResponse.error).toBe('Uploaded file must be a .sql file')
    })

    it('should successfully process a valid SQL dump', async () => {
        vi.mocked(executeOperation).mockResolvedValueOnce({} as any)

        const sqlFile = new File(
            ['CREATE TABLE users (id INT, name TEXT);'],
            'dump.sql',
            {
                type: 'application/sql',
            }
        )

        const request = await createFormDataRequest(sqlFile)

        const response = await importDumpRoute(
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(200)
        const jsonResponse = (await response.json()) as {
            result: { message: string }
        }
        expect(jsonResponse.result.message).toContain(
            'SQL dump import completed'
        )
    })

    it('should reject requests without an SQL file', async () => {
        const formData = new FormData()
        const request = new Request('http://localhost', {
            method: 'POST',
            body: formData,
        })

        const response = await importDumpRoute(
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(400)
        const jsonResponse = (await response.json()) as { error: string }
        expect(jsonResponse.error).toBe('No SQL file uploaded')
    })

    it('should remove SQLite format header if present', async () => {
        const sqlFile = new File(
            ['CREATE TABLE users (id INT, name TEXT);'],
            'dump.sql',
            { type: 'application/sql' }
        )

        const request = await createFormDataRequest(sqlFile)
        const response = await importDumpRoute(
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(200)
        const jsonResponse = (await response.json()) as {
            result: { details: { statement: string }[] }
        }

        expect(jsonResponse.result.details.length).toBe(1)
        expect(jsonResponse.result.details[0].statement).toBe(
            'CREATE TABLE users (id INT, name TEXT);'
        )
    })

    it('should return 207 if an unexpected error occurs', async () => {
        const consoleErrorSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})

        vi.mocked(executeOperation).mockImplementation(() => {
            throw new Error('Unexpected server crash')
        })

        const sqlFile = new File(['SELECT * FROM users;'], 'dump.sql', {
            type: 'application/sql',
        })

        const request = await createFormDataRequest(sqlFile)
        const response = await importDumpRoute(
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(207)
    })
    it('should strip SQLite format header and import remaining statements', async () => {
        vi.mocked(executeOperation).mockResolvedValue([{ ok: 1 }] as any)

        const sqlFile = new File(
            ['SQLite format 3\x00extra-header-bytes\nCREATE TABLE users (id INT);'],
            'dump.sql',
            { type: 'application/sql' }
        )

        const request = await createFormDataRequest(sqlFile)
        const response = await importDumpRoute(request, mockDataSource, mockConfig)

        expect(response.status).toBe(200)
        expect(vi.mocked(executeOperation)).toHaveBeenCalledTimes(1)
        expect(vi.mocked(executeOperation).mock.calls[0][0]).toEqual([
            { sql: 'CREATE TABLE users (id INT);' },
        ])
    })

    it('should skip comments/blank lines and keep trailing statement without semicolon', async () => {
        vi.mocked(executeOperation).mockResolvedValue([{ ok: 1 }] as any)

        const sqlFile = new File(
            ['-- seed dump\n\nCREATE TABLE a (id INT);\nINSERT INTO a VALUES (1)'],
            'dump.sql',
            { type: 'application/sql' }
        )

        const request = await createFormDataRequest(sqlFile)
        const response = await importDumpRoute(request, mockDataSource, mockConfig)

        expect(response.status).toBe(200)
        expect(vi.mocked(executeOperation)).toHaveBeenCalledTimes(2)
        const seen = vi.mocked(executeOperation).mock.calls.map((c) => (c[0] as { sql: string }[])[0].sql)
        expect(seen[0]).toContain('CREATE TABLE a')
        expect(seen[1]).toContain('INSERT INTO a VALUES (1)')
    })

    it('should return 500 when form parsing fails (outer catch)', async () => {
        const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

        const bad = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'multipart/form-data; boundary=x' },
            body: 'not-valid-form-data!!!',
        })

        const response = await importDumpRoute(bad, mockDataSource, mockConfig)

        expect(response.status).toBe(500)
        consoleErrorSpy.mockRestore()
    })
})
