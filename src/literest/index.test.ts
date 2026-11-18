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

        it('should handle IN operator and multiple filter operators', async () => {
            vi.mocked(executeQuery).mockResolvedValue([{ name: 'id', pk: 1 }])
            const searchParams = new URLSearchParams({
                'status.in': 'active,pending',
                'age.gte': '18',
                'name.like': '%Ali%',
            })

            // @ts-expect-error: Testing private method
            const { query, params } = await liteRest.buildSelectQuery(
                'users',
                'main',
                undefined,
                searchParams
            )

            expect(query).toContain('status IN (?, ?)')
            expect(query).toContain('age >= ?')
            expect(query).toContain('name LIKE ?')
            expect(params).toEqual(['active', 'pending', '18', '%Ali%'])
        })
    })

    describe('Edge cases, fake/missing tables, -1, null, and CRUD endpoints', () => {
        it('should throw error when table name is missing in path', async () => {
            const request = new Request('http://localhost/rest/', {
                method: 'GET',
            })
            await expect(liteRest.handleRequest(request)).rejects.toThrow(
                'Expected a table name in the path'
            )
        })

        it('should handle single-segment table path without schema', async () => {
            vi.mocked(executeQuery).mockResolvedValue([{ name: 'id', pk: 1 }])
            vi.mocked(executeTransaction).mockResolvedValue([
                [{ id: 1, name: 'Alice' }],
            ])

            const request = new Request('http://localhost/rest/users', {
                method: 'GET',
            })
            const response = await liteRest.handleRequest(request)
            expect(response.status).toBe(200)
        })

        it('should return 500 when querying a fake/non-existent table', async () => {
            vi.spyOn(console, 'error').mockImplementation(() => {})
            vi.mocked(executeQuery).mockRejectedValue(
                new Error('no such table: fake_table')
            )

            const request = new Request('http://localhost/rest/main/fake_table', {
                method: 'GET',
            })
            const response = await liteRest.handleRequest(request)
            expect(response.status).toBe(500)
            const body = (await response.json()) as { error: string }
            expect(body.error).toContain('no such table: fake_table')
        })

        it('should handle GET with id -1 and id null safely', async () => {
            vi.mocked(executeQuery).mockResolvedValue([{ name: 'id', pk: 1 }])
            vi.mocked(executeTransaction).mockResolvedValue([[]])

            const reqNeg = new Request('http://localhost/rest/main/users/-1', {
                method: 'GET',
            })
            const resNeg = await liteRest.handleRequest(reqNeg)
            expect(resNeg.status).toBe(200)

            const reqNull = new Request(
                'http://localhost/rest/main/users/null',
                { method: 'GET' }
            )
            const resNull = await liteRest.handleRequest(reqNull)
            expect(resNull.status).toBe(200)
        })

        it('should wrap non-array GET result in an array', async () => {
            vi.mocked(executeQuery).mockResolvedValue([{ name: 'id', pk: 1 }])
            vi.mocked(executeTransaction).mockResolvedValue([
                { id: 1, name: 'Single' },
            ])

            const request = new Request('http://localhost/rest/main/users/1', {
                method: 'GET',
            })
            const response = await liteRest.handleRequest(request)
            expect(response.status).toBe(200)
            const json = (await response.json()) as { result: any }
            expect(json.result).toEqual([{ id: 1, name: 'Single' }])
        })

        it('should handle POST empty object and non-Error rejection', async () => {
            vi.spyOn(console, 'error').mockImplementation(() => {})
            const emptyReq = new Request('http://localhost/rest/main/users', {
                method: 'POST',
                body: JSON.stringify({}),
            })
            const emptyRes = await liteRest.handleRequest(emptyReq)
            expect(emptyRes.status).toBe(400)

            vi.mocked(executeTransaction).mockRejectedValue({
                error: 'Constraint failed',
            })
            const errReq = new Request('http://localhost/rest/main/users', {
                method: 'POST',
                body: JSON.stringify({ name: 'Bob' }),
            })
            const errRes = await liteRest.handleRequest(errReq)
            expect(errRes.status).toBe(500)
        })

        it('should handle PATCH validation errors and success', async () => {
            vi.spyOn(console, 'error').mockImplementation(() => {})
            vi.mocked(executeQuery).mockResolvedValue([{ name: 'id', pk: 1 }])

            const noPkReq = new Request('http://localhost/rest/main/users', {
                method: 'PATCH',
                body: JSON.stringify({ name: 'Updated' }),
            })
            expect((await liteRest.handleRequest(noPkReq)).status).toBe(400)

            const onlyPkReq = new Request(
                'http://localhost/rest/main/users/1',
                {
                    method: 'PATCH',
                    body: JSON.stringify({ id: 1 }),
                }
            )
            expect((await liteRest.handleRequest(onlyPkReq)).status).toBe(400)

            vi.mocked(executeTransaction).mockResolvedValue([{}])
            const okReq = new Request('http://localhost/rest/main/users/1', {
                method: 'PATCH',
                body: JSON.stringify({ name: 'Updated' }),
            })
            expect((await liteRest.handleRequest(okReq)).status).toBe(200)
        })

        it('should handle PUT validation errors, DB error, and success', async () => {
            vi.spyOn(console, 'error').mockImplementation(() => {})
            vi.mocked(executeQuery).mockResolvedValue([{ name: 'id', pk: 1 }])

            const noPkReq = new Request('http://localhost/rest/main/users', {
                method: 'PUT',
                body: JSON.stringify({ name: 'PutUser' }),
            })
            expect((await liteRest.handleRequest(noPkReq)).status).toBe(400)

            const invalidReq = new Request(
                'http://localhost/rest/main/users/1',
                {
                    method: 'PUT',
                    body: JSON.stringify(null),
                }
            )
            expect((await liteRest.handleRequest(invalidReq)).status).toBe(400)

            const emptyReq = new Request('http://localhost/rest/main/users/1', {
                method: 'PUT',
                body: JSON.stringify({}),
            })
            expect((await liteRest.handleRequest(emptyReq)).status).toBe(400)

            vi.mocked(executeTransaction).mockResolvedValue([{}])
            const okReq = new Request('http://localhost/rest/main/users/1', {
                method: 'PUT',
                body: JSON.stringify({ name: 'PutUser' }),
            })
            expect((await liteRest.handleRequest(okReq)).status).toBe(200)

            vi.mocked(executeTransaction).mockRejectedValue(
                new Error('PUT failed')
            )
            const errReq = new Request('http://localhost/rest/main/users/1', {
                method: 'PUT',
                body: JSON.stringify({ name: 'PutUser' }),
            })
            expect((await liteRest.handleRequest(errReq)).status).toBe(500)
        })

        it('should handle DELETE missing id, missing PK, DB error, and success', async () => {
            vi.spyOn(console, 'error').mockImplementation(() => {})
            vi.mocked(executeQuery).mockResolvedValue([{ name: 'id', pk: 1 }])

            const noIdReq = new Request('http://localhost/rest/main/users', {
                method: 'DELETE',
            })
            expect((await liteRest.handleRequest(noIdReq)).status).toBe(400)

            vi.mocked(executeQuery).mockResolvedValue([])
            const noPkTableReq = new Request(
                'http://localhost/rest/main/users/1',
                { method: 'DELETE' }
            )
            expect((await liteRest.handleRequest(noPkTableReq)).status).toBe(
                400
            )

            vi.mocked(executeQuery).mockResolvedValue([{ name: 'id', pk: 1 }])
            vi.mocked(executeTransaction).mockResolvedValue([{}])
            const okReq = new Request('http://localhost/rest/main/users/1', {
                method: 'DELETE',
            })
            expect((await liteRest.handleRequest(okReq)).status).toBe(200)

            vi.mocked(executeTransaction).mockRejectedValue(
                new Error('DELETE failed')
            )
            const errReq = new Request('http://localhost/rest/main/users/1', {
                method: 'DELETE',
            })
            expect((await liteRest.handleRequest(errReq)).status).toBe(500)
        })

        it('should retrieve primary keys for postgresql, mysql, and composite keys', async () => {
            const pgLiteRest = new LiteREST(
                {
                    source: 'external',
                    external: { dialect: 'postgresql' },
                    rpc: { executeQuery: vi.fn() },
                } as any,
                mockConfig
            )
            vi.mocked(executeQuery).mockResolvedValue([
                { name: 'tenant_id' },
                { name: 'user_id' },
            ])
            // @ts-expect-error: Testing private method
            const pgPks = await pgLiteRest.getPrimaryKeyColumns('users')
            expect(pgPks).toEqual(['tenant_id', 'user_id'])

            const mysqlLiteRest = new LiteREST(
                {
                    source: 'external',
                    external: { dialect: 'mysql' },
                    rpc: { executeQuery: vi.fn() },
                } as any,
                mockConfig
            )
            vi.mocked(executeQuery).mockResolvedValue([{ name: 'id' }])
            // @ts-expect-error: Testing private method
            const mysqlPks = await mysqlLiteRest.getPrimaryKeyColumns('users')
            expect(mysqlPks).toEqual(['id'])

            // @ts-expect-error: Testing private method
            const compositeMissing = pgLiteRest.getPrimaryKeyConditions(
                ['tenant_id', 'user_id'],
                undefined,
                { tenant_id: 't1' },
                new URLSearchParams()
            )
            expect(compositeMissing.error).toContain('user_id')

            // @ts-expect-error: Testing private method
            const compositeOk = pgLiteRest.getPrimaryKeyConditions(
                ['tenant_id', 'user_id'],
                undefined,
                { tenant_id: 't1', user_id: 'u1' },
                new URLSearchParams()
            )
            expect(compositeOk.conditions).toEqual([
                'tenant_id = ?',
                'user_id = ?',
            ])
            expect(compositeOk.params).toEqual(['t1', 'u1'])
        })
    })
})
