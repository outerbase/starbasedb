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
    it('should stream a database dump when tables exist', async () => {
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'orders' }, { name: 'users' }])
            .mockResolvedValueOnce([
                { sql: 'CREATE TABLE orders (id INTEGER, total REAL);' },
            ])
            .mockResolvedValueOnce([
                { name: 'id', pk: 1 },
                { name: 'total', pk: 0 },
            ])
            .mockResolvedValueOnce([
                { id: 1, total: 99.99 },
                { id: 2, total: 49.5 },
            ])
            .mockResolvedValueOnce([
                { sql: 'CREATE TABLE users (id INTEGER, name TEXT);' },
            ])
            .mockResolvedValueOnce([
                { name: 'id', pk: 1 },
                { name: 'name', pk: 0 },
            ])
            .mockResolvedValueOnce([
                { id: 1, name: 'Alice' },
                { id: 2, name: 'Bob' },
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

    it('should handle empty databases', async () => {
        vi.mocked(executeOperation).mockResolvedValueOnce([])

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)

        expect(response).toBeInstanceOf(Response)
        const dumpText = await response.text()
        expect(dumpText).toBe('SQLite format 3\0')
    })

    it('should escape SQL values and emit NULL for nullish values', async () => {
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'users' }])
            .mockResolvedValueOnce([
                { sql: 'CREATE TABLE users (id INTEGER, bio TEXT);' },
            ])
            .mockResolvedValueOnce([
                { name: 'id', pk: 1 },
                { name: 'bio', pk: 0 },
                { name: 'empty', pk: 0 },
            ])
            .mockResolvedValueOnce([
                { id: 1, bio: "Alice's adventure", empty: null },
            ])

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)

        const dumpText = await response.text()
        expect(dumpText).toContain(
            "INSERT INTO \"users\" VALUES (1, 'Alice''s adventure', NULL);"
        )
    })

    it('should page table data with a stable order instead of loading the full table', async () => {
        const firstPage = Array.from({ length: 500 }, (_, index) => ({
            id: index + 1,
            name: `User${index + 1}`,
        }))
        const partialPage = [{ id: 501, name: 'User501' }]

        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'users' }])
            .mockResolvedValueOnce([
                { sql: 'CREATE TABLE users (id INTEGER, name TEXT);' },
            ])
            .mockResolvedValueOnce([
                { name: 'id', pk: 1 },
                { name: 'name', pk: 0 },
            ])
            .mockResolvedValueOnce(firstPage)
            .mockResolvedValueOnce(partialPage)

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)
        const dumpText = await response.text()

        expect(dumpText).toContain(
            'INSERT INTO "users" VALUES (501, \'User501\');'
        )
        expect(executeOperation).toHaveBeenNthCalledWith(
            4,
            [
                {
                    sql: 'SELECT * FROM "users" ORDER BY "id" LIMIT ? OFFSET ?;',
                    params: [500, 0],
                },
            ],
            mockDataSource,
            mockConfig
        )
        expect(executeOperation).toHaveBeenNthCalledWith(
            5,
            [
                {
                    sql: 'SELECT * FROM "users" ORDER BY "id" LIMIT ? OFFSET ?;',
                    params: [500, 500],
                },
            ],
            mockDataSource,
            mockConfig
        )
    })

    it('should fall back to rowid ordering when a table has no primary key', async () => {
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'logs' }])
            .mockResolvedValueOnce([
                { sql: 'CREATE TABLE logs (message TEXT);' },
            ])
            .mockResolvedValueOnce([{ name: 'message', pk: 0 }])
            .mockResolvedValueOnce([{ message: 'ready' }])

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)
        await response.text()

        expect(executeOperation).toHaveBeenNthCalledWith(
            4,
            [
                {
                    sql: 'SELECT * FROM "logs" ORDER BY rowid LIMIT ? OFFSET ?;',
                    params: [500, 0],
                },
            ],
            mockDataSource,
            mockConfig
        )
    })

    it('should return a 500 response when an error occurs before streaming starts', async () => {
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
})
