import { describe, it, expect, vi, beforeEach } from 'vitest'
import { dumpDatabaseRoute } from './dump'
import { executeTransaction } from '../operation'
import type { DataSource } from '../types'
import type { StarbaseDBConfiguration } from '../handler'

vi.mock('../operation', () => ({
    executeTransaction: vi.fn(),
}))

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

describe('Database Dump Module', () => {
    it('should return a database dump when tables exist', async () => {
        vi.mocked(executeTransaction)
            .mockResolvedValueOnce([[{ name: 'users' }, { name: 'orders' }]])
            .mockResolvedValueOnce([
                [{ sql: 'CREATE TABLE users (id INTEGER, name TEXT);' }],
            ])
            .mockResolvedValueOnce([[{ name: 'id' }, { name: 'name' }]])
            .mockResolvedValueOnce([
                [
                    { id: 1, name: 'Alice' },
                    { id: 2, name: 'Bob' },
                ],
            ])
            .mockResolvedValueOnce([
                [{ sql: 'CREATE TABLE orders (id INTEGER, total REAL);' }],
            ])
            .mockResolvedValueOnce([[{ name: 'id' }, { name: 'total' }]])
            .mockResolvedValueOnce([
                [
                    { id: 1, total: 99.99 },
                    { id: 2, total: 49.5 },
                ],
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

    it('should handle empty databases with no tables', async () => {
        vi.mocked(executeTransaction).mockResolvedValueOnce([[]])

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)

        expect(response).toBeInstanceOf(Response)
        expect(response.headers.get('Content-Type')).toBe(
            'application/x-sqlite3'
        )
        expect(await response.text()).toBe('SQLite format 3\0')
    })

    it('should handle databases with tables but no data', async () => {
        vi.mocked(executeTransaction)
            .mockResolvedValueOnce([[{ name: 'users' }]])
            .mockResolvedValueOnce([
                [{ sql: 'CREATE TABLE users (id INTEGER, name TEXT);' }],
            ])
            .mockResolvedValueOnce([[{ name: 'id' }, { name: 'name' }]])
            .mockResolvedValueOnce([[]])

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)

        expect(response).toBeInstanceOf(Response)
        const dumpText = await response.text()
        expect(dumpText).toContain(
            'CREATE TABLE users (id INTEGER, name TEXT);'
        )
        expect(dumpText).not.toContain('INSERT INTO "users" VALUES')
    })

    it('should escape single quotes and null values in SQL rows', async () => {
        vi.mocked(executeTransaction)
            .mockResolvedValueOnce([[{ name: 'users' }]])
            .mockResolvedValueOnce([
                [{ sql: 'CREATE TABLE users (id INTEGER, bio TEXT);' }],
            ])
            .mockResolvedValueOnce([[{ name: 'id' }, { name: 'bio' }]])
            .mockResolvedValueOnce([[{ id: 1, bio: "Alice's adventure" }]])

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)

        const dumpText = await response.text()
        expect(dumpText).toContain(
            "INSERT INTO \"users\" VALUES (1, 'Alice''s adventure');"
        )
    })

    it('should page dump rows as the stream is read', async () => {
        vi.mocked(executeTransaction)
            .mockResolvedValueOnce([[{ name: 'users' }]])
            .mockResolvedValueOnce([
                [{ sql: 'CREATE TABLE users (id INTEGER, name TEXT);' }],
            ])
            .mockResolvedValueOnce([[{ name: 'id' }, { name: 'name' }]])
            .mockResolvedValueOnce([[{ id: 1, name: 'Alice' }]])
            .mockResolvedValueOnce([[{ id: 2, name: 'Bob' }]])
            .mockResolvedValueOnce([[]])

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig, {
            batchSize: 1,
        })

        expect(executeTransaction).toHaveBeenCalledTimes(1)

        const dumpText = await response.text()
        expect(dumpText).toContain('INSERT INTO "users" VALUES (1, \'Alice\');')
        expect(dumpText).toContain('INSERT INTO "users" VALUES (2, \'Bob\');')
        expect(executeTransaction).toHaveBeenCalledTimes(6)
        expect(vi.mocked(executeTransaction).mock.calls[4][0].queries).toEqual([
            {
                sql: 'SELECT * FROM "users" LIMIT ? OFFSET ?;',
                params: [1, 1],
            },
        ])
    })

    it('should return a 500 response when an error occurs before streaming', async () => {
        const consoleErrorMock = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})
        vi.mocked(executeTransaction).mockRejectedValue(
            new Error('Database Error')
        )

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)

        expect(response.status).toBe(500)
        const jsonResponse: { error: string } = await response.json()
        expect(jsonResponse.error).toBe('Failed to create database dump')
        consoleErrorMock.mockRestore()
    })
})
