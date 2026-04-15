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

describe('Database Dump Module', () => {
    it('should return a database dump when tables exist', async () => {
        vi.mocked(executeOperation)
            // table list
            .mockResolvedValueOnce([{ name: 'users' }, { name: 'orders' }])
            // users schema
            .mockResolvedValueOnce([
                { sql: 'CREATE TABLE users (id INTEGER, name TEXT);' },
            ])
            // users data batch (only one batch needed)
            .mockResolvedValueOnce([
                { id: 1, name: 'Alice' },
                { id: 2, name: 'Bob' },
            ])
            // orders schema
            .mockResolvedValueOnce([
                { sql: 'CREATE TABLE orders (id INTEGER, total REAL);' },
            ])
            // orders data batch
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
        expect(dumpText).toContain('INSERT INTO "users" VALUES (1, \'Alice\');')
        expect(dumpText).toContain('INSERT INTO "users" VALUES (2, \'Bob\');')
        expect(dumpText).toContain(
            'CREATE TABLE orders (id INTEGER, total REAL);'
        )
        expect(dumpText).toContain('INSERT INTO "orders" VALUES (1, 99.99);')
        expect(dumpText).toContain('INSERT INTO "orders" VALUES (2, 49.5);')
    })

    it('should handle empty databases (no tables)', async () => {
        vi.mocked(executeOperation).mockResolvedValueOnce([])

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)

        expect(response).toBeInstanceOf(Response)
        expect(response.headers.get('Content-Type')).toBe(
            'application/x-sqlite3'
        )
        const dumpText = await response.text()
        expect(dumpText).toBe('SQLite format 3\0')
    })

    it('should handle databases with tables but no data', async () => {
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'users' }])
            .mockResolvedValueOnce([
                { sql: 'CREATE TABLE users (id INTEGER, name TEXT);' },
            ])
            // empty batch (no data)
            .mockResolvedValueOnce([])

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)

        expect(response).toBeInstanceOf(Response)
        const dumpText = await response.text()
        expect(dumpText).toContain(
            'CREATE TABLE users (id INTEGER, name TEXT);'
        )
        expect(dumpText).not.toContain('INSERT INTO "users" VALUES')
    })

    it('should escape single quotes properly in string values', async () => {
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'users' }])
            .mockResolvedValueOnce([
                { sql: 'CREATE TABLE users (id INTEGER, bio TEXT);' },
            ])
            .mockResolvedValueOnce([{ id: 1, bio: "Alice's adventure" }])

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)

        expect(response).toBeInstanceOf(Response)
        const dumpText = await response.text()
        expect(dumpText).toContain(
            "INSERT INTO \"users\" VALUES (1, 'Alice''s adventure');"
        )
    })

    it('should handle NULL values', async () => {
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'users' }])
            .mockResolvedValueOnce([
                { sql: 'CREATE TABLE users (id INTEGER, name TEXT);' },
            ])
            .mockResolvedValueOnce([{ id: 1, name: null }])

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)

        const dumpText = await response.text()
        expect(dumpText).toContain('INSERT INTO "users" VALUES (1, NULL);')
    })

    it('should stream data in batches when table has many rows', async () => {
        // Simulate a table with 501 rows → should trigger 2 batches (500 + 1)
        const batch1 = Array.from({ length: 500 }, (_, i) => ({
            id: i + 1,
            name: `user${i + 1}`,
        }))
        const batch2 = [{ id: 501, name: 'user501' }]

        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'users' }])
            .mockResolvedValueOnce([
                { sql: 'CREATE TABLE users (id INTEGER, name TEXT);' },
            ])
            .mockResolvedValueOnce(batch1) // first batch
            .mockResolvedValueOnce(batch2) // second batch

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)

        const dumpText = await response.text()
        expect(dumpText).toContain('INSERT INTO "users" VALUES (1, \'user1\');')
        expect(dumpText).toContain(
            'INSERT INTO "users" VALUES (501, \'user501\');'
        )

        // Verify LIMIT/OFFSET was used (4 calls: table list, schema, batch1, batch2)
        expect(executeOperation).toHaveBeenCalledTimes(4)
    })

    it('should return a 500 response when an error occurs', async () => {
        const consoleErrorMock = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})
        vi.mocked(executeOperation).mockRejectedValue(
            new Error('Database Error')
        )

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)

        expect(response.status).toBe(500)
        const jsonResponse: { error: string } = await response.json()
        expect(jsonResponse.error).toBe('Failed to create database dump')
    })
})
