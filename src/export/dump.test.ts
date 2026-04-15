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

async function collectStream(response: Response): Promise<string> {
    return await response.text()
}

describe('Database Dump Module', () => {
    it('should return a streaming database dump when tables exist', async () => {
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'users' }, { name: 'orders' }])
            .mockResolvedValueOnce([
                { sql: 'CREATE TABLE users (id INTEGER, name TEXT);' },
            ])
            .mockResolvedValueOnce([
                { id: 1, name: 'Alice' },
                { id: 2, name: 'Bob' },
            ])
            .mockResolvedValueOnce([
                { sql: 'CREATE TABLE orders (id INTEGER, total REAL);' },
            ])
            .mockResolvedValueOnce([
                { id: 1, total: 99.99 },
                { id: 2, total: 49.5 },
            ])

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)

        expect(response).toBeInstanceOf(Response)
        expect(response.headers.get('Content-Type')).toBe('text/sql')
        expect(response.headers.get('Content-Disposition')).toBe(
            'attachment; filename="database_dump.sql"'
        )

        const dumpText = await collectStream(response)
        expect(dumpText).toContain('BEGIN TRANSACTION;')
        expect(dumpText).toContain('COMMIT;')
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
        expect(response.headers.get('Content-Type')).toBe('text/sql')
        const dumpText = await collectStream(response)
        expect(dumpText).toContain('BEGIN TRANSACTION;')
        expect(dumpText).toContain('COMMIT;')
        expect(dumpText).not.toContain('INSERT INTO')
    })

    it('should handle databases with tables but no data', async () => {
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'users' }])
            .mockResolvedValueOnce([
                { sql: 'CREATE TABLE users (id INTEGER, name TEXT);' },
            ])
            .mockResolvedValueOnce([])

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)

        expect(response).toBeInstanceOf(Response)
        const dumpText = await collectStream(response)
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
        const dumpText = await collectStream(response)
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
        const dumpText = await collectStream(response)
        expect(dumpText).toContain('INSERT INTO "users" VALUES (1, NULL);')
    })

    it('should handle boolean values', async () => {
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'flags' }])
            .mockResolvedValueOnce([
                { sql: 'CREATE TABLE flags (id INTEGER, active INTEGER);' },
            ])
            .mockResolvedValueOnce([
                { id: 1, active: true },
                { id: 2, active: false },
            ])

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)
        const dumpText = await collectStream(response)
        expect(dumpText).toContain('INSERT INTO "flags" VALUES (1, 1);')
        expect(dumpText).toContain('INSERT INTO "flags" VALUES (2, 0);')
    })

    it('should escape table names with special characters', async () => {
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'my-table' }])
            .mockResolvedValueOnce([
                { sql: 'CREATE TABLE "my-table" (id INTEGER);' },
            ])
            .mockResolvedValueOnce([{ id: 1 }])

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)
        const dumpText = await collectStream(response)
        expect(dumpText).toContain('INSERT INTO "my-table" VALUES (1);')
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
        consoleErrorMock.mockRestore()
    })

    it('should fetch data in batches for large tables', async () => {
        const firstBatch = Array.from({ length: 500 }, (_, i) => ({
            id: i + 1,
            name: `user${i + 1}`,
        }))
        const secondBatch = Array.from({ length: 100 }, (_, i) => ({
            id: i + 501,
            name: `user${i + 501}`,
        }))

        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'users' }])
            .mockResolvedValueOnce([
                { sql: 'CREATE TABLE users (id INTEGER, name TEXT);' },
            ])
            .mockResolvedValueOnce(firstBatch)
            .mockResolvedValueOnce(secondBatch)

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)
        const dumpText = await collectStream(response)

        expect(dumpText).toContain('INSERT INTO "users" VALUES (1, \'user1\');')
        expect(dumpText).toContain(
            'INSERT INTO "users" VALUES (500, \'user500\');'
        )
        expect(dumpText).toContain(
            'INSERT INTO "users" VALUES (501, \'user501\');'
        )
        expect(dumpText).toContain(
            'INSERT INTO "users" VALUES (600, \'user600\');'
        )
    })
})
