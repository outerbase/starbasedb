import { describe, it, expect, vi, beforeEach } from 'vitest'
import { dumpDatabaseRoute } from './dump'
import { executeOperation, getTableDataChunked } from '.'
import type { DataSource } from '../types'
import type { StarbaseDBConfiguration } from '../handler'

// We mock the entire index module so that createStreamingExportResponse
// simply drains the async generator synchronously and returns a plain
// text Response — this keeps the tests synchronous and assertion-friendly
// without requiring a full Streams API environment.
vi.mock('.', () => ({
    executeOperation: vi.fn(),
    getTableDataChunked: vi.fn(),
    createStreamingExportResponse: vi.fn(
        async (
            fileName: string,
            contentType: string,
            generator: AsyncGenerator<string>
        ) => {
            let body = ''
            for await (const chunk of generator) {
                body += chunk
            }
            return new Response(body, {
                headers: {
                    'Content-Type': contentType,
                    'Content-Disposition': `attachment; filename="${fileName}"`,
                },
            })
        }
    ),
}))

vi.mock('../utils', () => ({
    createResponse: vi.fn(
        (data: any, message: string, status: number) =>
            new Response(JSON.stringify({ result: data, error: message }), {
                status,
                headers: { 'Content-Type': 'application/json' },
            })
    ),
}))

/**
 * Helper: build a mock async generator that yields pre-defined chunks.
 */
async function* mockChunkedGen(chunks: any[][]): AsyncGenerator<any[]> {
    for (const chunk of chunks) {
        yield chunk
    }
}

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

describe('Database Dump Module (streaming)', () => {
    it('should return a streaming response with correct headers', async () => {
        // list tables
        vi.mocked(executeOperation).mockResolvedValueOnce([
            { name: 'users' },
            { name: 'orders' },
        ])
        // schema for users
        vi.mocked(executeOperation).mockResolvedValueOnce([
            { sql: 'CREATE TABLE users (id INTEGER, name TEXT)' },
        ])
        // schema for orders
        vi.mocked(executeOperation).mockResolvedValueOnce([
            { sql: 'CREATE TABLE orders (id INTEGER, total REAL)' },
        ])

        vi.mocked(getTableDataChunked)
            .mockImplementationOnce(() =>
                mockChunkedGen([
                    [
                        { id: 1, name: 'Alice' },
                        { id: 2, name: 'Bob' },
                    ],
                ])
            )
            .mockImplementationOnce(() =>
                mockChunkedGen([[{ id: 1, total: 99.99 }]])
            )

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)

        expect(response).toBeInstanceOf(Response)
        expect(response.headers.get('Content-Type')).toBe('application/sql')
        expect(response.headers.get('Content-Disposition')).toContain(
            'database_dump.sql'
        )
    })

    it('should emit BEGIN TRANSACTION and COMMIT', async () => {
        vi.mocked(executeOperation).mockResolvedValueOnce([]) // no tables

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)
        const text = await response.text()

        expect(text).toContain('BEGIN TRANSACTION')
        expect(text).toContain('COMMIT')
    })

    it('should include DROP TABLE IF EXISTS before CREATE TABLE', async () => {
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'users' }])
            .mockResolvedValueOnce([
                { sql: 'CREATE TABLE users (id INTEGER, name TEXT)' },
            ])

        vi.mocked(getTableDataChunked).mockImplementationOnce(() =>
            mockChunkedGen([])
        )

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)
        const text = await response.text()

        expect(text).toContain('DROP TABLE IF EXISTS users')
        expect(text).toContain('CREATE TABLE users (id INTEGER, name TEXT)')
    })

    it('should escape single quotes in string values', async () => {
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'users' }])
            .mockResolvedValueOnce([
                { sql: 'CREATE TABLE users (id INTEGER, bio TEXT)' },
            ])

        vi.mocked(getTableDataChunked).mockImplementationOnce(() =>
            mockChunkedGen([[{ id: 1, bio: "Alice's adventure" }]])
        )

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)
        const text = await response.text()

        expect(text).toContain(
            "INSERT INTO users VALUES (1, 'Alice''s adventure')"
        )
    })

    it('should emit NULL for null values', async () => {
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'items' }])
            .mockResolvedValueOnce([
                { sql: 'CREATE TABLE items (id INTEGER, notes TEXT)' },
            ])

        vi.mocked(getTableDataChunked).mockImplementationOnce(() =>
            mockChunkedGen([[{ id: 1, notes: null }]])
        )

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)
        const text = await response.text()

        expect(text).toContain('INSERT INTO items VALUES (1, NULL)')
    })

    it('should handle an empty database (no tables)', async () => {
        vi.mocked(executeOperation).mockResolvedValueOnce([])

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)

        expect(response).toBeInstanceOf(Response)
        const text = await response.text()
        expect(text).toContain('BEGIN TRANSACTION')
        expect(text).not.toContain('INSERT INTO')
    })

    it('should return a 500 response when listing tables fails', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        vi.mocked(executeOperation).mockRejectedValue(
            new Error('Database Error')
        )

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)

        expect(response.status).toBe(500)
        const jsonResponse: { error: string } = await response.json()
        expect(jsonResponse.error).toBe('Failed to create database dump')
    })

    it('should page through rows in multiple chunks for large tables', async () => {
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'big_table' }])
            .mockResolvedValueOnce([
                { sql: 'CREATE TABLE big_table (id INTEGER)' },
            ])

        vi.mocked(getTableDataChunked).mockImplementationOnce(() =>
            mockChunkedGen([
                Array.from({ length: 1000 }, (_, i) => ({ id: i + 1 })),
                Array.from({ length: 500 }, (_, i) => ({ id: 1001 + i })),
            ])
        )

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)
        const text = await response.text()

        // 1500 INSERT statements expected
        const insertCount = (text.match(/INSERT INTO big_table/g) || []).length
        expect(insertCount).toBe(1500)
    })
})
