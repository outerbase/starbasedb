import { describe, it, expect, vi, beforeEach } from 'vitest'
import { dumpDatabaseRoute } from './dump'
import { exportTableToJsonRoute } from './json'
import { exportTableToCsvRoute } from './csv'
import { executeOperation, getTableData, createExportResponse } from '.'
import { createResponse } from '../utils'
import type { DataSource } from '../types'
import type { StarbaseDBConfiguration } from '../handler'

/**
 * Preservation Property Tests — Synchronous GET Export Endpoints Unchanged
 *
 *
 *
 * These tests verify that existing synchronous GET export endpoints continue
 * to work identically after the async chunked export fix is applied.
 * They MUST PASS on both unfixed and fixed code.
 */

vi.mock('.', () => ({
    executeOperation: vi.fn(),
    getTableData: vi.fn(),
    createExportResponse: vi.fn(),
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

let internalDataSource: DataSource
let externalDataSource: DataSource
let mockConfig: StarbaseDBConfiguration

beforeEach(() => {
    vi.clearAllMocks()

    internalDataSource = {
        source: 'internal',
        rpc: { executeQuery: vi.fn() },
    } as any

    externalDataSource = {
        source: 'external',
        external: { dialect: 'sqlite' },
        rpc: { executeQuery: vi.fn() },
    } as any

    mockConfig = {
        role: 'admin',
        features: { export: true },
    }
})

describe('Preservation Property: Synchronous GET Export Endpoints Unchanged', () => {
    /**
     * Property 2: Preservation — GET /export/dump with a small database
     * returns 200 with Content-Type application/x-sqlite3 and valid SQL dump.
     *
     *
     */
    describe('GET /export/dump — small database', () => {
        it('should return 200 with Content-Type application/x-sqlite3 and valid SQL dump content', async () => {
            vi.mocked(executeOperation)
                .mockResolvedValueOnce([{ name: 'users' }])
                .mockResolvedValueOnce([
                    {
                        sql: 'CREATE TABLE users (id INTEGER, name TEXT);',
                    },
                ])
                .mockResolvedValueOnce([
                    { id: 1, name: 'Alice' },
                    { id: 2, name: 'Bob' },
                ])

            const response = await dumpDatabaseRoute(
                internalDataSource,
                mockConfig
            )

            expect(response).toBeInstanceOf(Response)
            expect(response.status).toBe(200)
            expect(response.headers.get('Content-Type')).toBe(
                'application/x-sqlite3'
            )
            expect(response.headers.get('Content-Disposition')).toBe(
                'attachment; filename="database_dump.sql"'
            )

            const dumpText = await response.text()
            expect(dumpText).toContain('SQLite format 3')
            expect(dumpText).toContain(
                'CREATE TABLE users (id INTEGER, name TEXT);'
            )
            expect(dumpText).toContain("INSERT INTO users VALUES (1, 'Alice');")
            expect(dumpText).toContain("INSERT INTO users VALUES (2, 'Bob');")
        })
    })

    /**
     * Property 2: Preservation — GET /export/json/:tableName for a small table
     * returns 200 with Content-Type application/json.
     *
     *
     */
    describe('GET /export/json/:tableName — small table', () => {
        it('should return 200 with Content-Type application/json', async () => {
            const mockData = [
                { id: 1, name: 'Alice' },
                { id: 2, name: 'Bob' },
            ]
            vi.mocked(getTableData).mockResolvedValue(mockData)

            vi.mocked(createExportResponse).mockReturnValue(
                new Response(JSON.stringify(mockData, null, 4), {
                    status: 200,
                    headers: {
                        'Content-Type': 'application/json',
                        'Content-Disposition':
                            'attachment; filename="users_export.json"',
                    },
                })
            )

            const response = await exportTableToJsonRoute(
                'users',
                internalDataSource,
                mockConfig
            )

            expect(response.status).toBe(200)
            expect(response.headers.get('Content-Type')).toBe(
                'application/json'
            )
            expect(getTableData).toHaveBeenCalledWith(
                'users',
                internalDataSource,
                mockConfig
            )
            expect(createExportResponse).toHaveBeenCalledWith(
                JSON.stringify(mockData, null, 4),
                'users_export.json',
                'application/json'
            )
        })
    })

    /**
     * Property 2: Preservation — GET /export/csv/:tableName for a small table
     * returns 200 with Content-Type text/csv.
     *
     *
     */
    describe('GET /export/csv/:tableName — small table', () => {
        it('should return 200 with Content-Type text/csv', async () => {
            vi.mocked(getTableData).mockResolvedValue([
                { id: 1, name: 'Alice' },
                { id: 2, name: 'Bob' },
            ])

            vi.mocked(createExportResponse).mockReturnValue(
                new Response('id,name\n1,Alice\n2,Bob\n', {
                    status: 200,
                    headers: {
                        'Content-Type': 'text/csv',
                        'Content-Disposition':
                            'attachment; filename="users_export.csv"',
                    },
                })
            )

            const response = await exportTableToCsvRoute(
                'users',
                internalDataSource,
                mockConfig
            )

            expect(response.status).toBe(200)
            expect(response.headers.get('Content-Type')).toBe('text/csv')
            expect(getTableData).toHaveBeenCalledWith(
                'users',
                internalDataSource,
                mockConfig
            )
            expect(createExportResponse).toHaveBeenCalledWith(
                'id,name\n1,Alice\n2,Bob\n',
                'users_export.csv',
                'text/csv'
            )
        })
    })

    /**
     * Property 2: Preservation — GET /export/json/:tableName for a non-existent
     * table returns 404.
     *
     *
     */
    describe('GET /export/json/:tableName — non-existent table', () => {
        it('should return 404 with error message', async () => {
            vi.mocked(getTableData).mockResolvedValue(null)

            const response = await exportTableToJsonRoute(
                'no_such_table',
                internalDataSource,
                mockConfig
            )

            expect(response.status).toBe(404)
            const body = (await response.json()) as { error: string }
            expect(body.error).toBe("Table 'no_such_table' does not exist.")
        })
    })

    /**
     * Property 2: Preservation — Export requests with non-internal data source
     * return 400.
     *
     *
     *
     * Note: The isInternalSource middleware in handler.ts enforces this at the
     * route level. Here we verify the middleware behavior by testing that the
     * export functions themselves work with any DataSource (the guard is in
     * the middleware). We test the middleware behavior via a StarbaseDB
     * integration-style test.
     */
    describe('Export with non-internal data source', () => {
        it('should return 400 when data source is not internal (via handler middleware)', async () => {
            const { StarbaseDB } = await import('../handler')

            const mockExecuteQuery = vi.fn().mockResolvedValue([])
            ;(mockExecuteQuery as any)[Symbol.dispose] = vi.fn()

            const extDataSource: DataSource = {
                source: 'external',
                external: { dialect: 'sqlite' } as any,
                rpc: { executeQuery: mockExecuteQuery } as any,
            }

            const config: StarbaseDBConfiguration = {
                role: 'admin',
                features: { export: true },
            }

            const db = new StarbaseDB({
                dataSource: extDataSource,
                config,
            })

            const mockCtx = {
                waitUntil: vi.fn(),
            } as unknown as ExecutionContext

            const dumpReq = new Request('https://example.com/export/dump', {
                method: 'GET',
            })
            const dumpResp = await db.handle(dumpReq, mockCtx)
            expect(dumpResp.status).toBe(400)

            const dumpBody = (await dumpResp.json()) as { error: string }
            expect(dumpBody.error).toBe(
                'Function is only available for internal data source.'
            )
        })
    })
})
