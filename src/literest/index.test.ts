import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LiteREST } from './index'
import { createResponse } from '../utils'
import { executeQuery, executeTransaction } from '../operation'
import type { DataSource } from '../types'
import type { StarbaseDBConfiguration } from '../handler'

vi.mock('../operation', () => ({
    executeQuery: vi.fn(),
    executeTransaction: vi.fn(),
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

vi.mocked(executeTransaction).mockImplementation(async ({ queries }) => {
    return [{ id: 1, name: 'Alice' }]
})

let mockDataSource: DataSource
let mockConfig: StarbaseDBConfiguration
let liteRest: LiteREST

beforeEach(() => {
    vi.clearAllMocks()

    mockDataSource = {
        source: 'external',
        external: {
            dialect: 'sqlite',
        } as any,
        rpc: {
            executeQuery: vi.fn(),
        },
    } as any

    mockConfig = {
        outerbaseApiKey: 'mock-api-key',
        role: 'admin',
        features: { allowlist: true, rls: true, rest: true },
    }

    liteRest = new LiteREST(mockDataSource, mockConfig)
})

describe('LiteREST', () => {
    describe('sanitizeIdentifier', () => {
        it('should remove non-alphanumeric characters except underscores', () => {
            // @ts-expect-error: Testing private method
            expect(liteRest.sanitizeIdentifier('table$name!')).toBe('tablename')
            // @ts-expect-error
            expect(liteRest.sanitizeIdentifier('valid_name123')).toBe(
                'valid_name123'
            )
        })
    })

    describe('sanitizeOperator', () => {
        it('should return valid SQL operator', () => {
            // @ts-expect-error: Testing private method
            expect(liteRest.sanitizeOperator('eq')).toBe('=')
            // @ts-expect-error
            expect(liteRest.sanitizeOperator('gte')).toBe('>=')
            // @ts-expect-error
            expect(liteRest.sanitizeOperator('invalid')).toBe('=')
        })
    })

    describe('handleRequest', () => {
        it('should return 405 for unsupported methods', async () => {
            const request = new Request('http://localhost/rest/main/users', {
                method: 'OPTIONS',
            })
            const response = await liteRest.handleRequest(request)
            expect(response.status).toBe(405)
        })

        it('should handle GET requests successfully', async () => {
            vi.mocked(executeQuery).mockResolvedValue([
                { id: 1, name: 'Alice' },
            ])

            const request = new Request('http://localhost/rest/main/users', {
                method: 'GET',
            })
            const response = await liteRest.handleRequest(request)
            expect(response).toBeInstanceOf(Response)
            expect(response.status).toBe(200)
            const jsonResponse = (await response.json()) as { result: any }
            expect(jsonResponse.result).toEqual([{ id: 1, name: 'Alice' }])
        })

        it('should return 500 for GET errors', async () => {
            const consoleErrorMock = vi
                .spyOn(console, 'error')
                .mockImplementation(() => {})
            vi.mocked(executeQuery).mockRejectedValue(new Error('DB Error'))

            const request = new Request('http://localhost/rest/main/users', {
                method: 'GET',
            })
            const response = await liteRest.handleRequest(request)

            expect(response.status).toBe(500)
            const jsonResponse = (await response.json()) as { error: string }
            expect(jsonResponse.error).toBe('DB Error')
        })

        it('should handle POST requests successfully', async () => {
            vi.mocked(executeTransaction).mockResolvedValue([
                { id: 1, name: 'New User' },
            ])

            const request = new Request('http://localhost/rest/main/users', {
                method: 'POST',
                body: JSON.stringify({ name: 'New User' }),
            })

            const response = await liteRest.handleRequest(request)

            expect(response.status).toBe(201)
            const jsonResponse = (await response.json()) as {
                result: { message: string; data: { name: string } }
            }
            expect(jsonResponse.result).toEqual({
                message: 'Resource created successfully',
                data: { name: 'New User' },
            })
        })

        it('should return 400 for invalid POST data', async () => {
            const request = new Request('http://localhost/rest/main/users', {
                method: 'POST',
                body: JSON.stringify(null),
                headers: { 'Content-Type': 'application/json' },
            })
            const response = await liteRest.handleRequest(request)

            expect(response).toBeInstanceOf(Response)
            expect(response.status).toBe(400)

            const jsonResponse = (await response.json()) as { error: string }
            expect(jsonResponse.error).toBe('Invalid data format')
        })

        it('should return 500 for POST errors', async () => {
            vi.mocked(executeTransaction).mockRejectedValue(
                new Error('Insert failed')
            )

            const request = new Request('http://localhost/rest/main/users', {
                method: 'POST',
                body: JSON.stringify({ name: 'Error User' }),
                headers: { 'Content-Type': 'application/json' },
            })

            const response = await liteRest.handleRequest(request)

            expect(response).toBeInstanceOf(Response)
            expect(response.status).toBe(500)

            const jsonResponse = (await response.json()) as { error: string }
            expect(jsonResponse.error).toBe('Insert failed')
        })

        it('should handle PATCH requests successfully', async () => {
            vi.mocked(executeQuery).mockImplementation(async ({ sql }) => {
                console.log('Mock executeQuery called with:', sql)

                if (sql.includes('PRAGMA table_info(users)')) {
                    return [{ name: 'id', pk: 1 }]
                }

                return []
            })
            vi.mocked(executeTransaction).mockResolvedValue([])

            const request = new Request('http://localhost/rest/main/users/1', {
                method: 'PATCH',
                body: JSON.stringify({ name: 'Updated Name' }),
                headers: { 'Content-Type': 'application/json' },
            })

            const response = await liteRest.handleRequest(request)
            console.log('PATCH Test Response:', response)

            expect(response).toBeInstanceOf(Response)
            expect(response.status).toBe(200)

            const jsonResponse = (await response.json()) as {
                result: { message: string; data: { name: string } }
            }

            expect(jsonResponse.result).toEqual({
                message: 'Resource updated successfully',
                data: { name: 'Updated Name' },
            })
        })

        it('should return 400 for invalid PATCH data', async () => {
            const request = new Request('http://localhost/rest/main/users/1', {
                method: 'PATCH',
                body: JSON.stringify(null),
                headers: { 'Content-Type': 'application/json' },
            })

            const response = await liteRest.handleRequest(request)

            expect(response.status).toBe(400)

            const jsonResponse = (await response.json()) as { error: string }
            expect(jsonResponse.error).toBe('Invalid data format')
        })

        it('should return 400 for PATCH request missing composite PK values', async () => {
            vi.mocked(executeQuery).mockResolvedValue([
                { name: 'user_id', pk: 1 },
                { name: 'group_id', pk: 1 },
            ])

            const request = new Request('http://localhost/rest/main/users', {
                method: 'PATCH',
                body: JSON.stringify({ user_id: 1, name: 'Updated' }),
                headers: { 'Content-Type': 'application/json' },
            })

            const response = await liteRest.handleRequest(request)
            expect(response.status).toBe(400)

            const jsonResponse = (await response.json()) as { error: string }
            expect(jsonResponse.error).toBe(
                "Missing primary key value for 'group_id'"
            )
        })

        it('should handle PUT requests successfully', async () => {
            vi.mocked(executeQuery).mockImplementation(async ({ sql }) => {
                console.log('Mock executeQuery called with:', sql)

                if (sql.includes('PRAGMA table_info(users)')) {
                    return [{ name: 'id', pk: 1 }]
                }

                return []
            })
            vi.mocked(executeTransaction).mockResolvedValue([])

            const request = new Request('http://localhost/rest/main/users/1', {
                method: 'PUT',
                body: JSON.stringify({ id: 1, name: 'Replaced User' }),
                headers: { 'Content-Type': 'application/json' },
            })

            const response = await liteRest.handleRequest(request)

            expect(response).toBeInstanceOf(Response)
            expect(response.status).toBe(200)

            const jsonResponse = (await response.json()) as {
                result: { message: string; data: { id: number; name: string } }
            }

            expect(jsonResponse.result).toEqual({
                message: 'Resource replaced successfully',
                data: { id: 1, name: 'Replaced User' },
            })
        })

        it('should return 400 for missing PUT data', async () => {
            const request = new Request('http://localhost/rest/main/users/1', {
                method: 'PUT',
                body: JSON.stringify(null),
                headers: { 'Content-Type': 'application/json' },
            })

            const response = await liteRest.handleRequest(request)

            expect(response.status).toBe(400)

            const jsonResponse = (await response.json()) as { error: string }
            expect(jsonResponse.error).toBe('Invalid data format')
        })

        it('should return 405 for invalid HTTP methods', async () => {
            const methods = ['HEAD']
            for (const method of methods) {
                const request = new Request(
                    'http://localhost/rest/main/users',
                    {
                        method,
                    }
                )
                const response = await liteRest.handleRequest(request)
                expect(response.status).toBe(405)
                const jsonResponse = (await response.json()) as {
                    error: string
                }
                expect(jsonResponse.error).toBe('Method not allowed')
            }
        })

        it('should handle DELETE requests successfully', async () => {
            vi.mocked(executeQuery).mockImplementation(async ({ sql }) => {
                if (sql.includes('PRAGMA table_info(users)')) {
                    return [{ name: 'id', pk: 1 }]
                }

                return []
            })
            vi.mocked(executeTransaction).mockResolvedValue([])

            const request = new Request('http://localhost/rest/main/users/1', {
                method: 'DELETE',
            })
            const response = await liteRest.handleRequest(request)

            expect(response).toBeInstanceOf(Response)
            expect(response.status).toBe(200)

            const jsonResponse = (await response.json()) as {
                result: { message: string }
            }
            expect(jsonResponse.result).toEqual({
                message: 'Resource deleted successfully',
            })
        })

        it('should return 400 for DELETE without ID', async () => {
            const request = new Request('http://localhost/rest/main/users', {
                method: 'DELETE',
            })
            const response = await liteRest.handleRequest(request)

            expect(response).toBeInstanceOf(Response)
            expect(response.status).toBe(400)

            const jsonResponse = (await response.json()) as { error: string }
            expect(jsonResponse.error).toBe(
                "Missing primary key value for 'id'"
            )
        })

        it('should return 500 for DELETE errors', async () => {
            vi.mocked(executeQuery).mockRejectedValue(
                new Error('Delete failed')
            )

            const request = new Request('http://localhost/rest/main/users/1', {
                method: 'DELETE',
            })
            const response = await liteRest.handleRequest(request)

            expect(response).toBeInstanceOf(Response)
            expect(response.status).toBe(500)

            const jsonResponse = (await response.json()) as { error: string }
            expect(jsonResponse.error).toBe('Delete failed')
        })
        it('should return 400 if DELETE is attempted with missing composite PK values', async () => {
            vi.mocked(executeQuery).mockResolvedValue([
                { name: 'user_id', pk: 1 },
                { name: 'group_id', pk: 1 },
            ])

            const request = new Request('http://localhost/rest/main/users/1', {
                method: 'DELETE',
            })
            const response = await liteRest.handleRequest(request)

            expect(response.status).toBe(400)
            const jsonResponse = (await response.json()) as { error: string }
            expect(jsonResponse.error).toBe(
                "Missing primary key value for 'group_id'"
            )
        })

        it('should return 500 if primary key query fails', async () => {
            vi.mocked(executeQuery).mockRejectedValue(new Error('DB Error'))

            const request = new Request('http://localhost/rest/main/users/1', {
                method: 'GET',
            })
            const response = await liteRest.handleRequest(request)

            expect(response.status).toBe(500)
            const jsonResponse = (await response.json()) as { error: string }
            expect(jsonResponse.error).toBe('DB Error')
        })
    })

    describe('buildSelectQuery', () => {
        it('should build a valid SELECT query', async () => {
            vi.mocked(executeQuery).mockResolvedValue([{ name: 'id', pk: 1 }])

            // @ts-expect-error: Testing private method
            const { query, params } = await liteRest.buildSelectQuery(
                'users',
                undefined,
                undefined,
                new URLSearchParams()
            )

            expect(query).toBe('SELECT * FROM users')
            expect(params).toEqual([])
        })

        it('should add WHERE clause for primary key', async () => {
            vi.mocked(executeQuery).mockResolvedValue([{ name: 'id', pk: 1 }])

            // @ts-expect-error: Testing private method
            const { query, params } = await liteRest.buildSelectQuery(
                'users',
                undefined,
                '1',
                new URLSearchParams()
            )

            expect(query).toContain('WHERE id = ?')
            expect(params).toEqual(['1'])
        })

        it('should add ORDER BY clause', async () => {
            const searchParams = new URLSearchParams({
                sort_by: 'name',
                order: 'desc',
            })

            // @ts-expect-error: Testing private method
            const { query } = await liteRest.buildSelectQuery(
                'users',
                undefined,
                undefined,
                searchParams
            )

            expect(query).toContain('ORDER BY name DESC')
        })

        it('should add LIMIT and OFFSET', async () => {
            const searchParams = new URLSearchParams({
                limit: '10',
                offset: '5',
            })

            // @ts-expect-error: Testing private method
            const { query, params } = await liteRest.buildSelectQuery(
                'users',
                undefined,
                undefined,
                searchParams
            )

            expect(query).toContain('LIMIT ? OFFSET ?')
            expect(params).toEqual([10, 5])
        })

        it('should ignore invalid limit and offset parameters', async () => {
            const searchParams = new URLSearchParams({
                limit: 'invalid',
                offset: '-5',
            })

            // @ts-expect-error: Testing private method
            const { query, params } = await liteRest.buildSelectQuery(
                'users',
                undefined,
                undefined,
                searchParams
            )

            expect(query).not.toContain('LIMIT ? OFFSET ?')
            expect(params).toEqual([])
        })

        it('should ignore invalid sort_by parameter', async () => {
            const searchParams = new URLSearchParams({
                sort_by: 'DROP TABLE users;',
            })

            // @ts-expect-error: Testing private method
            const { query } = await liteRest.buildSelectQuery(
                'users',
                undefined,
                undefined,
                searchParams
            )

            expect(query).not.toContain('DROP TABLE users')
        })
    })
})
