import { describe, it, expect, vi, beforeEach } from 'vitest'
import { dumpDatabaseRoute } from './dump'
import { executeOperation } from '.'
import { createResponse } from '../utils'
import type { DataSource } from '../types'
import type { StarbaseDBConfiguration } from '../handler'

vi.mock('.', () => ({
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
    vi.restoreAllMocks()
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

    // Re-mock after restore
    vi.mocked(executeOperation).mockReset()
    vi.mocked(createResponse).mockImplementation(
        (data: any, message: any, status: any) =>
            new Response(JSON.stringify({ result: data, error: message }), {
                status,
                headers: { 'Content-Type': 'application/json' },
            })
    )
})

async function collectResponseText(response: Response): Promise<string> {
    const reader = response.body?.getReader()
    if (!reader) return ''

    const chunks: Uint8Array[] = []
    while (true) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
    }

    const totalLength = chunks.reduce((sum, c) => sum + c.length, 0)
    const result = new Uint8Array(totalLength)
    let offset = 0
    for (const chunk of chunks) {
        result.set(chunk, offset)
        offset += chunk.length
    }

    return new TextDecoder().decode(result)
}

describe('Database Dump Module', () => {
    it('should return a streaming database dump when tables exist', async () => {
        const mock = vi.mocked(executeOperation)
        // 1: tables list
        mock.mockResolvedValueOnce([{ name: 'users' }, { name: 'orders' }])
        // 2: users schema
        mock.mockResolvedValueOnce([
            { sql: 'CREATE TABLE users (id INTEGER, name TEXT);' },
        ])
        // 3: users data (2 rows < BATCH_SIZE=500, generator exits after this)
        mock.mockResolvedValueOnce([
            { id: 1, name: 'Alice' },
            { id: 2, name: 'Bob' },
        ])
        // 4: orders schema
        mock.mockResolvedValueOnce([
            { sql: 'CREATE TABLE orders (id INTEGER, total REAL);' },
        ])
        // 5: orders data (2 rows < BATCH_SIZE, generator exits)
        mock.mockResolvedValueOnce([
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

        const dumpText = await collectResponseText(response)
        expect(dumpText).toContain(
            'CREATE TABLE users (id INTEGER, name TEXT);'
        )
        expect(dumpText).toContain("INSERT INTO `users` VALUES (1, 'Alice');")
        expect(dumpText).toContain("INSERT INTO `users` VALUES (2, 'Bob');")
        expect(dumpText).toContain(
            'CREATE TABLE orders (id INTEGER, total REAL);'
        )
        expect(dumpText).toContain('INSERT INTO `orders` VALUES (1, 99.99);')
        expect(dumpText).toContain('INSERT INTO `orders` VALUES (2, 49.5);')
    })

    it('should handle empty databases (no tables)', async () => {
        vi.mocked(executeOperation).mockResolvedValueOnce([])

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)

        expect(response).toBeInstanceOf(Response)
        expect(response.headers.get('Content-Type')).toBe(
            'application/x-sqlite3'
        )
        const dumpText = await collectResponseText(response)
        expect(dumpText).toContain('SQLite format 3')
        expect(dumpText).not.toContain('INSERT INTO')
    })

    it('should handle databases with tables but no data', async () => {
        const mock = vi.mocked(executeOperation)
        mock.mockResolvedValueOnce([{ name: 'users' }])
        mock.mockResolvedValueOnce([
            { sql: 'CREATE TABLE users (id INTEGER, name TEXT);' },
        ])
        // Empty data (first batch returns nothing)
        mock.mockResolvedValueOnce([])

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)

        expect(response).toBeInstanceOf(Response)
        const dumpText = await collectResponseText(response)
        expect(dumpText).toContain(
            'CREATE TABLE users (id INTEGER, name TEXT);'
        )
        expect(dumpText).not.toContain('INSERT INTO `users` VALUES')
    })

    it('should escape single quotes properly in string values', async () => {
        const mock = vi.mocked(executeOperation)
        mock.mockResolvedValueOnce([{ name: 'users' }])
        mock.mockResolvedValueOnce([
            { sql: 'CREATE TABLE users (id INTEGER, bio TEXT);' },
        ])
        mock.mockResolvedValueOnce([{ id: 1, bio: "Alice's adventure" }])

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)

        expect(response).toBeInstanceOf(Response)
        const dumpText = await collectResponseText(response)
        expect(dumpText).toContain(
            "INSERT INTO `users` VALUES (1, 'Alice''s adventure');"
        )
    })

    it('should return a 500 response when initial table list fails', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        // First call (table list) throws synchronously
        vi.mocked(executeOperation).mockImplementationOnce(() => {
            throw new Error('Database Error')
        })

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)

        expect(response.status).toBe(500)
        const jsonResponse: { error: string } = await response.json()
        expect(jsonResponse.error).toBe('Failed to create database dump')
    })
})
