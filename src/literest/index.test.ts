import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LiteREST } from './index'
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

let mockDataSource: DataSource
let mockConfig: StarbaseDBConfiguration
let liteRest: LiteREST

async function dispatchRestRequest(
    path: string,
    init?: RequestInit
): Promise<{ status: number; body: { result?: any; error?: string } }> {
    const request = new Request(`http://localhost${path}`, init)
    const response = await liteRest.handleRequest(request)
    const body = (await response.json()) as { result?: any; error?: string }
    return { status: response.status, body }
}

function mockPrimaryKeySchema(
    columns: { name: string; pk: number }[] = [{ name: 'id', pk: 1 }]
) {
    vi.mocked(executeQuery).mockImplementation(async ({ sql }) => {
        if (sql.includes('PRAGMA table_info(users)')) {
            return columns
        }
        return []
    })
}

beforeEach(() => {
    vi.clearAllMocks()

    vi.mocked(executeTransaction).mockImplementation(async () => {
        return [{ id: 1, name: 'Alice' }]
    })

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
    describe('sanitizeIdentifier & sanitizeOperator', () => {
        it('strips non-alphanumeric characters while preserving underscores', () => {
            // @ts-expect-error: Testing private identifier sanitizer
            expect(liteRest.sanitizeIdentifier('table$name!')).toBe('tablename')
            // @ts-expect-error: Testing private identifier sanitizer
            expect(liteRest.sanitizeIdentifier('valid_name123')).toBe(
                'valid_name123'
            )
        })

        it('maps filter operators to SQL comparison tokens', () => {
            // @ts-expect-error: Testing private operator mapper
            expect(liteRest.sanitizeOperator('eq')).toBe('=')
            // @ts-expect-error: Testing private operator mapper
            expect(liteRest.sanitizeOperator('gte')).toBe('>=')
            // @ts-expect-error: Testing private operator mapper
            expect(liteRest.sanitizeOperator('invalid')).toBe('=')
        })
    })

    describe('handleRequest HTTP methods', () => {
        it('rejects unsupported HTTP verbs with 405', async () => {
            for (const method of ['OPTIONS', 'HEAD']) {
                const { status, body } = await dispatchRestRequest(
                    '/rest/main/users',
                    { method }
                )
                expect(status).toBe(405)
                expect(body.error).toBe('Method not allowed')
            }
        })

        it('executes GET and POST requests against the table resource', async () => {
            mockPrimaryKeySchema()
            const getRes = await dispatchRestRequest('/rest/main/users', {
                method: 'GET',
            })
            expect(getRes.status).toBe(200)
            expect(getRes.body.result).toEqual([{ id: 1, name: 'Alice' }])

            vi.mocked(executeTransaction).mockResolvedValue([
                { id: 1, name: 'New User' },
            ])
            const postRes = await dispatchRestRequest('/rest/main/users', {
                method: 'POST',
                body: JSON.stringify({ name: 'New User' }),
            })
            expect(postRes.status).toBe(201)
            expect(postRes.body.result).toEqual({
                message: 'Resource created successfully',
                data: { name: 'New User' },
            })
        })

        it('executes PATCH, PUT, and DELETE mutations with primary key lookup', async () => {
            mockPrimaryKeySchema()
            vi.mocked(executeTransaction).mockResolvedValue([])

            const patchRes = await dispatchRestRequest('/rest/main/users/1', {
                method: 'PATCH',
                body: JSON.stringify({ name: 'Updated Name' }),
                headers: { 'Content-Type': 'application/json' },
            })
            expect(patchRes.status).toBe(200)
            expect(patchRes.body.result.message).toBe(
                'Resource updated successfully'
            )

            const putRes = await dispatchRestRequest('/rest/main/users/1', {
                method: 'PUT',
                body: JSON.stringify({ id: 1, name: 'Replaced User' }),
                headers: { 'Content-Type': 'application/json' },
            })
            expect(putRes.status).toBe(200)
            expect(putRes.body.result.message).toBe(
                'Resource replaced successfully'
            )

            const deleteRes = await dispatchRestRequest('/rest/main/users/1', {
                method: 'DELETE',
            })
            expect(deleteRes.status).toBe(200)
            expect(deleteRes.body.result.message).toBe(
                'Resource deleted successfully'
            )
        })

        it('validates payload structure and composite primary keys with 400 status', async () => {
            mockPrimaryKeySchema()

            for (const method of ['POST', 'PATCH', 'PUT']) {
                const { status, body } = await dispatchRestRequest(
                    '/rest/main/users/1',
                    {
                        method,
                        body: JSON.stringify(null),
                        headers: { 'Content-Type': 'application/json' },
                    }
                )
                expect(status).toBe(400)
                expect(body.error).toBe('Invalid data format')
            }

            const missingDeleteId = await dispatchRestRequest(
                '/rest/main/users',
                { method: 'DELETE' }
            )
            expect(missingDeleteId.status).toBe(400)
            expect(missingDeleteId.body.error).toBe(
                "Missing primary key value for 'id'"
            )

            mockPrimaryKeySchema([
                { name: 'user_id', pk: 1 },
                { name: 'group_id', pk: 1 },
            ])
            const missingCompositePatch = await dispatchRestRequest(
                '/rest/main/users',
                {
                    method: 'PATCH',
                    body: JSON.stringify({ user_id: 1, name: 'Updated' }),
                    headers: { 'Content-Type': 'application/json' },
                }
            )
            expect(missingCompositePatch.status).toBe(400)
            expect(missingCompositePatch.body.error).toBe(
                "Missing primary key value for 'group_id'"
            )

            const missingCompositeDelete = await dispatchRestRequest(
                '/rest/main/users/1',
                { method: 'DELETE' }
            )
            expect(missingCompositeDelete.status).toBe(400)
            expect(missingCompositeDelete.body.error).toBe(
                "Missing primary key value for 'group_id'"
            )
        })

        it('returns 500 when underlying query or transaction execution rejects', async () => {
            vi.spyOn(console, 'error').mockImplementation(() => {})
            mockPrimaryKeySchema()
            vi.mocked(executeTransaction).mockRejectedValue(
                new Error('Transaction execution failed')
            )

            const postErr = await dispatchRestRequest('/rest/main/users', {
                method: 'POST',
                body: JSON.stringify({ name: 'Error User' }),
                headers: { 'Content-Type': 'application/json' },
            })
            expect(postErr.status).toBe(500)
            expect(postErr.body.error).toBe('Transaction execution failed')

            vi.mocked(executeQuery).mockRejectedValue(new Error('DB Error'))
            const getErr = await dispatchRestRequest('/rest/main/users/1', {
                method: 'GET',
            })
            expect(getErr.status).toBe(500)
            expect(getErr.body.error).toBe('DB Error')

            const deleteErr = await dispatchRestRequest('/rest/main/users/1', {
                method: 'DELETE',
            })
            expect(deleteErr.status).toBe(500)
            expect(deleteErr.body.error).toBe('DB Error')
        })
    })

    describe('allowlist bypass integration', () => {
        it('bypasses allowlist on primary key introspection and REST queries by default when ENABLE_ALLOWLIST is active', async () => {
            mockPrimaryKeySchema()
            const clientConfig: StarbaseDBConfiguration = {
                role: 'client',
                features: { allowlist: true, rest: true },
            }
            liteRest = new LiteREST(mockDataSource, clientConfig)

            const { status } = await dispatchRestRequest('/rest/main/users/1', {
                method: 'GET',
            })
            expect(status).toBe(200)
            expect(executeQuery).toHaveBeenCalledWith(
                expect.objectContaining({
                    sql: 'PRAGMA table_info(users);',
                    bypassAllowlist: true,
                })
            )
            expect(executeTransaction).toHaveBeenCalledWith(
                expect.objectContaining({
                    bypassAllowlist: true,
                })
            )
        })

        it('respects allowlistBypassRest = false for REST queries while keeping schema introspection bypassed', async () => {
            mockPrimaryKeySchema()
            const strictConfig: StarbaseDBConfiguration = {
                role: 'client',
                features: {
                    allowlist: true,
                    allowlistBypassRest: false,
                    rest: true,
                },
            }
            liteRest = new LiteREST(mockDataSource, strictConfig)

            await dispatchRestRequest('/rest/main/users/1', { method: 'GET' })
            expect(executeQuery).toHaveBeenCalledWith(
                expect.objectContaining({
                    bypassAllowlist: true,
                })
            )
            expect(executeTransaction).toHaveBeenCalledWith(
                expect.objectContaining({
                    bypassAllowlist: false,
                })
            )
        })
    })

    describe('buildSelectQuery', () => {
        it('constructs parameterized SELECT queries with PK, sort, and pagination clauses', async () => {
            mockPrimaryKeySchema()

            // @ts-expect-error: Testing private query builder
            const baseResult = await liteRest.buildSelectQuery(
                'users',
                undefined,
                '1',
                new URLSearchParams()
            )
            expect(baseResult.query).toBe('SELECT * FROM users WHERE id = ?')
            expect(baseResult.params).toEqual(['1'])

            const paginatedParams = new URLSearchParams({
                sort_by: 'name',
                order: 'desc',
                limit: '10',
                offset: '5',
            })
            // @ts-expect-error: Testing private query builder
            const pagedResult = await liteRest.buildSelectQuery(
                'users',
                undefined,
                undefined,
                paginatedParams
            )
            expect(pagedResult.query).toContain('ORDER BY name DESC')
            expect(pagedResult.query).toContain('LIMIT ? OFFSET ?')
            expect(pagedResult.params).toEqual([10, 5])
        })

        it('sanitizes sort_by identifiers and ignores invalid pagination bounds', async () => {
            mockPrimaryKeySchema()
            const invalidParams = new URLSearchParams({
                sort_by: 'DROP TABLE users;',
                limit: 'invalid',
                offset: '-5',
            })

            // @ts-expect-error: Testing private query builder
            const { query, params } = await liteRest.buildSelectQuery(
                'users',
                undefined,
                undefined,
                invalidParams
            )
            expect(query).not.toContain('DROP TABLE users')
            expect(query).not.toContain('LIMIT ? OFFSET ?')
            expect(params).toEqual([])
        })
    })
})
