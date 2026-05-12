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
    vi.mocked(executeOperation).mockResolvedValue({ ok: true } as any)

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

    it('should remove the SQLite format header before executing statements', async () => {
        const sqlFile = new File(
            [
                [
                    'SQLite format 3',
                    'CREATE TABLE users (id INTEGER PRIMARY KEY);',
                    'INSERT INTO users (id) VALUES (1);',
                ].join('\n'),
            ],
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
        expect(executeOperation).toHaveBeenNthCalledWith(
            1,
            [{ sql: 'CREATE TABLE users (id INTEGER PRIMARY KEY);' }],
            mockDataSource,
            mockConfig
        )
        expect(executeOperation).toHaveBeenNthCalledWith(
            2,
            [{ sql: 'INSERT INTO users (id) VALUES (1);' }],
            mockDataSource,
            mockConfig
        )

        const jsonResponse = (await response.json()) as {
            result: { message: string; details: { statement: string }[] }
        }

        expect(jsonResponse.result.message).toBe(
            'SQL dump import completed. 2 statements succeeded, 0 failed.'
        )
        expect(jsonResponse.result.details).toHaveLength(2)
        expect(
            jsonResponse.result.details.some((detail) =>
                detail.statement.includes('SQLite format 3')
            )
        ).toBe(false)
    })

    it('should parse comments blank lines multiline statements and final statement without semicolon', async () => {
        const sqlContent = [
            '-- dump comment',
            '',
            'CREATE TABLE users (',
            '  id INTEGER PRIMARY KEY,',
            '  name TEXT',
            ');',
            '-- seed data',
            'INSERT INTO users (id, name)',
            "VALUES (1, 'Ada');",
            'CREATE INDEX idx_users_name ON users(name)',
        ].join('\n')
        const sqlFile = new File([sqlContent], 'dump.sql', {
            type: 'application/sql',
        })

        const request = await createFormDataRequest(sqlFile)
        const response = await importDumpRoute(
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(200)
        expect(executeOperation).toHaveBeenCalledTimes(3)
        expect(executeOperation).toHaveBeenNthCalledWith(
            1,
            [
                {
                    sql: [
                        'CREATE TABLE users (',
                        '  id INTEGER PRIMARY KEY,',
                        '  name TEXT',
                        ');',
                    ].join('\n'),
                },
            ],
            mockDataSource,
            mockConfig
        )
        expect(executeOperation).toHaveBeenNthCalledWith(
            2,
            [
                {
                    sql: [
                        'INSERT INTO users (id, name)',
                        "VALUES (1, 'Ada');",
                    ].join('\n'),
                },
            ],
            mockDataSource,
            mockConfig
        )
        expect(executeOperation).toHaveBeenNthCalledWith(
            3,
            [{ sql: 'CREATE INDEX idx_users_name ON users(name)' }],
            mockDataSource,
            mockConfig
        )
    })

    it('should accept comments-only dumps without executing statements', async () => {
        const sqlFile = new File(
            [['-- only comments', '', '-- no SQL here'].join('\n')],
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
        expect(executeOperation).not.toHaveBeenCalled()

        const jsonResponse = (await response.json()) as {
            result: { message: string; details: unknown[] }
        }
        expect(jsonResponse.result.message).toBe(
            'SQL dump import completed. 0 statements succeeded, 0 failed.'
        )
        expect(jsonResponse.result.details).toEqual([])
    })

    it('should return 207 with details for mixed statement results', async () => {
        const consoleErrorSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ rowsAffected: 0 }] as any)
            .mockRejectedValueOnce(new Error('insert failed'))

        try {
            const sqlFile = new File(
                [
                    [
                        'CREATE TABLE users (id INTEGER);',
                        'INSERT INTO users VALUES (1);',
                    ].join('\n'),
                ],
                'dump.sql',
                { type: 'application/sql' }
            )

            const request = await createFormDataRequest(sqlFile)
            const response = await importDumpRoute(
                request,
                mockDataSource,
                mockConfig
            )

            expect(response.status).toBe(207)
            const jsonResponse = (await response.json()) as {
                result: {
                    message: string
                    details: {
                        statement: string
                        success: boolean
                        result?: unknown
                        error?: string
                    }[]
                }
            }
            expect(jsonResponse.result.message).toBe(
                'SQL dump import completed. 1 statements succeeded, 1 failed.'
            )
            expect(jsonResponse.result.details).toEqual([
                {
                    statement: 'CREATE TABLE users (id INTEGER);',
                    success: true,
                    result: [{ rowsAffected: 0 }],
                },
                {
                    statement: 'INSERT INTO users VALUES (1);',
                    success: false,
                    error: 'insert failed',
                },
            ])
        } finally {
            consoleErrorSpy.mockRestore()
        }
    })

    it('should return 500 when multipart parsing fails', async () => {
        const consoleErrorSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})
        const request = {
            method: 'POST',
            headers: new Headers({
                'Content-Type': 'multipart/form-data; boundary=broken',
            }),
            formData: vi.fn().mockRejectedValue(new Error('bad multipart')),
        } as unknown as Request

        try {
            const response = await importDumpRoute(
                request,
                mockDataSource,
                mockConfig
            )

            expect(response.status).toBe(500)
            expect(executeOperation).not.toHaveBeenCalled()
            const jsonResponse = (await response.json()) as { error: string }
            expect(jsonResponse.error).toBe('bad multipart')
        } finally {
            consoleErrorSpy.mockRestore()
        }
    })

    it('should reject sqlFile form values that are not files', async () => {
        const formData = new FormData()
        formData.append('sqlFile', 'not-a-file')
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
        expect(executeOperation).not.toHaveBeenCalled()
        const jsonResponse = (await response.json()) as { error: string }
        expect(jsonResponse.error).toBe('No SQL file uploaded')
    })

    it('should return 207 if an unexpected error occurs', async () => {
        const consoleErrorSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})

        vi.mocked(executeOperation).mockImplementation(() => {
            throw new Error('Unexpected server crash')
        })

        try {
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
        } finally {
            consoleErrorSpy.mockRestore()
        }
    })
})
