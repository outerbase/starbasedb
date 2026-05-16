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
            .mockResolvedValueOnce([{ name: 'users' }, { name: 'orders' }])
            .mockResolvedValueOnce([
                { sql: 'CREATE TABLE users (id INTEGER, name TEXT);' },
            ])
            .mockResolvedValueOnce([{ name: 'id' }, { name: 'name' }])
            .mockResolvedValueOnce([
                { sql: 'CREATE TABLE orders (id INTEGER, total REAL);' },
            ])
            .mockResolvedValueOnce([{ name: 'id' }, { name: 'total' }])
            .mockResolvedValueOnce([
                {
                    __starbasedb_export_cursor_rowid: 1,
                    id: 1,
                    name: 'Alice',
                },
                {
                    __starbasedb_export_cursor_rowid: 2,
                    id: 2,
                    name: 'Bob',
                },
            ])
            .mockResolvedValueOnce([
                {
                    __starbasedb_export_cursor_rowid: 1,
                    id: 1,
                    total: 99.99,
                },
                {
                    __starbasedb_export_cursor_rowid: 2,
                    id: 2,
                    total: 49.5,
                },
            ])

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)

        expect(response).toBeInstanceOf(Response)
        expect(response.headers.get('Content-Type')).toBe(
            'application/sql; charset=utf-8'
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
            'application/sql; charset=utf-8'
        )
        const dumpText = await response.text()
        expect(dumpText).toBe(
            'PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\nCOMMIT;\n'
        )
    })

    it('should handle databases with tables but no data', async () => {
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'users' }])
            .mockResolvedValueOnce([
                { sql: 'CREATE TABLE users (id INTEGER, name TEXT);' },
            ])
            .mockResolvedValueOnce([{ name: 'id' }, { name: 'name' }])
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
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'users' }])
            .mockResolvedValueOnce([
                { sql: 'CREATE TABLE users (id INTEGER, bio TEXT);' },
            ])
            .mockResolvedValueOnce([{ name: 'id' }, { name: 'bio' }])
            .mockResolvedValueOnce([
                {
                    __starbasedb_export_cursor_rowid: 1,
                    id: 1,
                    bio: "Alice's adventure",
                },
            ])

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)

        expect(response).toBeInstanceOf(Response)
        const dumpText = await response.text()
        expect(dumpText).toContain(
            "INSERT INTO \"users\" VALUES (1, 'Alice''s adventure');"
        )
    })

    it('should page table data instead of loading a full table at once', async () => {
        const firstPage = Array.from({ length: 1000 }, (_, index) => ({
            __starbasedb_export_cursor_rowid: index + 1,
            id: index + 1,
            name: `User ${index + 1}`,
        }))

        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'users' }])
            .mockResolvedValueOnce([
                { sql: 'CREATE TABLE users (id INTEGER, name TEXT);' },
            ])
            .mockResolvedValueOnce([{ name: 'id' }, { name: 'name' }])
            .mockResolvedValueOnce(firstPage)
            .mockResolvedValueOnce([
                {
                    __starbasedb_export_cursor_rowid: 1001,
                    id: 1001,
                    name: 'Last User',
                },
            ])

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)
        const dumpText = await response.text()

        expect(dumpText).toContain(
            'INSERT INTO "users" VALUES (1001, \'Last User\');'
        )
        expect(executeOperation).toHaveBeenNthCalledWith(
            4,
            [
                {
                    sql: 'SELECT rowid AS "__starbasedb_export_cursor_rowid", "id", "name" FROM "users" ORDER BY rowid LIMIT ?;',
                    params: [1000],
                },
            ],
            mockDataSource,
            mockConfig
        )
        expect(executeOperation).toHaveBeenNthCalledWith(
            5,
            [
                {
                    sql: 'SELECT rowid AS "__starbasedb_export_cursor_rowid", "id", "name" FROM "users" WHERE rowid > ? ORDER BY rowid LIMIT ?;',
                    params: [1000, 1000],
                },
            ],
            mockDataSource,
            mockConfig
        )
    })

    it('should emit SQL NULL for nullish values', async () => {
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'users' }])
            .mockResolvedValueOnce([
                { sql: 'CREATE TABLE users (id INTEGER, bio TEXT);' },
            ])
            .mockResolvedValueOnce([{ name: 'id' }, { name: 'bio' }])
            .mockResolvedValueOnce([
                {
                    __starbasedb_export_cursor_rowid: 1,
                    id: 1,
                    bio: null,
                },
            ])

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)
        const dumpText = await response.text()

        expect(dumpText).toContain('INSERT INTO "users" VALUES (1, NULL);')
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
