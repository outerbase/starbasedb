import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DataSource } from '../types'
import type { StarbaseDBConfiguration } from '../handler'

// Track all executeOperation calls
const mockExecuteOperation = vi.fn()

// Mock the module before importing dump
vi.mock('.', () => ({
    executeOperation: (...args: any[]) => mockExecuteOperation(...args),
    getTableDataChunked: async function* (
        tableName: string,
        dataSource: any,
        config: any,
        chunkSize: number = 1000
    ) {
        // Use the mocked executeOperation to simulate chunked reads
        let offset = 0
        while (true) {
            const chunk = await mockExecuteOperation(
                [{ sql: `SELECT * FROM ${tableName} LIMIT ? OFFSET ?;`, params: [chunkSize, offset] }],
                dataSource,
                config
            )
            if (!chunk || chunk.length === 0) break
            yield chunk
            if (chunk.length < chunkSize) break
            offset += chunkSize
        }
    },
    createStreamingExportResponse: (
        producer: any,
        fileName: string,
        contentType: string
    ) => {
        // Synchronous test helper: run producer into a buffer, return Response
        const chunks: string[] = []
        const encoder = new TextEncoder()
        const decoder = new TextDecoder()

        const { readable, writable } = new TransformStream()
        const writer = writable.getWriter()

        // Run producer and collect output
        const done = (async () => {
            try {
                await producer(writer)
            } finally {
                await writer.close()
            }
        })()

        // Return response backed by readable stream
        const response = new Response(readable, {
            headers: {
                'Content-Type': contentType,
                'Content-Disposition': `attachment; filename="${fileName}"`,
            },
        })

        // Store promise so tests can await completion
        ;(response as any).__producerDone = done

        return response
    },
    writeChunk: async (writer: WritableStreamDefaultWriter, content: string) => {
        await writer.write(new TextEncoder().encode(content))
    },
    createExportResponse: (data: any, fileName: string, contentType: string) => {
        const blob = new Blob([data], { type: contentType })
        return new Response(blob, {
            headers: {
                'Content-Type': contentType,
                'Content-Disposition': `attachment; filename="${fileName}"`,
            },
        })
    },
}))

vi.mock('../utils', () => ({
    createResponse: vi.fn(
        (data: any, message: any, status: any) =>
            new Response(JSON.stringify({ result: data, error: message }), {
                status,
                headers: { 'Content-Type': 'application/json' },
            })
    ),
}))

// Import dump AFTER mocks are set up
import { dumpDatabaseRoute } from './dump'

let mockDataSource: DataSource
let mockConfig: StarbaseDBConfiguration

beforeEach(() => {
    vi.clearAllMocks()
    mockExecuteOperation.mockReset()

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

describe('Database Dump Module', () => {
    it('should return a database dump when tables exist', async () => {
        mockExecuteOperation
            // Table names
            .mockResolvedValueOnce([{ name: 'users' }, { name: 'orders' }])
            // users schema
            .mockResolvedValueOnce([
                { sql: 'CREATE TABLE users (id INTEGER, name TEXT);' },
            ])
            // users data chunk (LIMIT/OFFSET query, 2 rows < 1000 chunkSize → generator breaks)
            .mockResolvedValueOnce([
                { id: 1, name: 'Alice' },
                { id: 2, name: 'Bob' },
            ])
            // orders schema
            .mockResolvedValueOnce([
                { sql: 'CREATE TABLE orders (id INTEGER, total REAL);' },
            ])
            // orders data chunk (2 rows < 1000 → generator breaks)
            .mockResolvedValueOnce([
                { id: 1, total: 99.99 },
                { id: 2, total: 49.5 },
            ])

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)

        expect(response).toBeInstanceOf(Response)
        expect(response.headers.get('Content-Type')).toBe(
            'application/x-sqlite3'
        )
        expect(response.headers.get('Content-Disposition')).toBe(
            'attachment; filename="database_dump.sql"'
        )

        const dumpText = await response.text()
        expect(dumpText).toContain(
            'CREATE TABLE users (id INTEGER, name TEXT);'
        )
        expect(dumpText).toContain("INSERT INTO users VALUES (1, 'Alice');")
        expect(dumpText).toContain("INSERT INTO users VALUES (2, 'Bob');")
        expect(dumpText).toContain(
            'CREATE TABLE orders (id INTEGER, total REAL);'
        )
        expect(dumpText).toContain('INSERT INTO orders VALUES (1, 99.99);')
        expect(dumpText).toContain('INSERT INTO orders VALUES (2, 49.5);')
    })

    it('should handle empty databases (no tables)', async () => {
        mockExecuteOperation.mockResolvedValueOnce([])

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)

        expect(response).toBeInstanceOf(Response)
        expect(response.headers.get('Content-Type')).toBe(
            'application/x-sqlite3'
        )
        const dumpText = await response.text()
        expect(dumpText).toBe('SQLite format 3\0')
    })

    it('should handle databases with tables but no data', async () => {
        mockExecuteOperation
            .mockResolvedValueOnce([{ name: 'users' }])
            .mockResolvedValueOnce([
                { sql: 'CREATE TABLE users (id INTEGER, name TEXT);' },
            ])
            // Empty chunk = no data
            .mockResolvedValueOnce([])

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)

        expect(response).toBeInstanceOf(Response)
        const dumpText = await response.text()
        expect(dumpText).toContain(
            'CREATE TABLE users (id INTEGER, name TEXT);'
        )
        expect(dumpText).not.toContain('INSERT INTO users VALUES')
    })

    it('should escape single quotes properly in string values', async () => {
        mockExecuteOperation
            .mockResolvedValueOnce([{ name: 'users' }])
            .mockResolvedValueOnce([
                { sql: 'CREATE TABLE users (id INTEGER, bio TEXT);' },
            ])
            .mockResolvedValueOnce([{ id: 1, bio: "It's a test" }])
            .mockResolvedValueOnce([])

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)

        const dumpText = await response.text()
        expect(dumpText).toContain(
            "INSERT INTO users VALUES (1, 'It''s a test');"
        )
    })

    it('should stream data in chunks for large tables', async () => {
        const chunk1 = Array.from({ length: 1000 }, (_, i) => ({
            id: i + 1,
            name: `user${i + 1}`,
        }))
        const chunk2 = Array.from({ length: 1000 }, (_, i) => ({
            id: i + 1001,
            name: `user${i + 1001}`,
        }))
        const chunk3 = Array.from({ length: 500 }, (_, i) => ({
            id: i + 2001,
            name: `user${i + 2001}`,
        }))

        mockExecuteOperation
            .mockResolvedValueOnce([{ name: 'users' }])
            .mockResolvedValueOnce([
                { sql: 'CREATE TABLE users (id INTEGER, name TEXT);' },
            ])
            .mockResolvedValueOnce(chunk1)
            .mockResolvedValueOnce(chunk2)
            .mockResolvedValueOnce(chunk3)
            .mockResolvedValueOnce([]) // end-of-data

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)

        expect(response).toBeInstanceOf(Response)
        const dumpText = await response.text()

        expect(dumpText).toContain("INSERT INTO users VALUES (1, 'user1');")
        expect(dumpText).toContain(
            "INSERT INTO users VALUES (2500, 'user2500');"
        )
        expect(dumpText).toContain(
            "INSERT INTO users VALUES (1000, 'user1000');"
        )
        expect(dumpText).toContain(
            "INSERT INTO users VALUES (1001, 'user1001');"
        )
    })
})
