import { describe, it, expect, vi, beforeEach } from 'vitest'
import { dumpDatabaseRoute } from './dump'
import { executeOperation } from '.'
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
    vi.mocked(executeOperation).mockReset()

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

/**
 * Build an `executeOperation` mock that walks a virtual schema/data set the
 * way the streaming dump does (one query per page, terminating on a short
 * page). Centralising this means each test only describes the *data*, not the
 * call ordering, which is now driven by the generator.
 */
function mockSchema(
    tables: Array<{ name: string; schema?: string; rows: any[] }>
) {
    // Drive the executeOperation mock by inspecting the SQL each call sends,
    // not by call ordering — the streaming dump issues a different number of
    // queries per table depending on whether the row set fits in one page.
    vi.mocked(executeOperation).mockImplementation(async (queries: any) => {
        const sql: string = queries[0].sql
        if (/FROM sqlite_master WHERE type='table';$/.test(sql)) {
            return tables.map((t) => ({ name: t.name }))
        }
        const schemaMatch = sql.match(
            /FROM sqlite_master WHERE type='table' AND name=\?/
        )
        if (schemaMatch) {
            const name = queries[0].params?.[0]
            const t = tables.find((x) => x.name === name)
            return t?.schema ? [{ sql: t.schema }] : []
        }
        const dataMatch = sql.match(/^SELECT \* FROM (\w+) LIMIT \? OFFSET \?/)
        if (dataMatch) {
            const name = dataMatch[1]
            const offset: number = queries[0].params?.[1] ?? 0
            const t = tables.find((x) => x.name === name)
            // Single-page semantics: any offset > 0 yields nothing (the
            // generator terminates on the short first page anyway).
            return offset === 0 ? (t?.rows ?? []) : []
        }
        return []
    })
}

describe('Database Dump Module (streaming)', () => {
    it('streams INSERT statements for every table', async () => {
        mockSchema([
            {
                name: 'users',
                schema: 'CREATE TABLE users (id INTEGER, name TEXT)',
                rows: [
                    { id: 1, name: 'Alice' },
                    { id: 2, name: 'Bob' },
                ],
            },
            {
                name: 'orders',
                schema: 'CREATE TABLE orders (id INTEGER, total REAL)',
                rows: [
                    { id: 1, total: 99.99 },
                    { id: 2, total: 49.5 },
                ],
            },
        ])

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)

        expect(response).toBeInstanceOf(Response)
        expect(response.headers.get('Content-Type')).toBe(
            'application/x-sqlite3'
        )
        expect(response.headers.get('Content-Disposition')).toBe(
            'attachment; filename="database_dump.sql"'
        )
        // Critical: the body must be a stream, not a buffered Blob. If
        // someone "fixes" this by re-buffering the dump, this assertion
        // breaks.
        expect(response.body).toBeInstanceOf(ReadableStream)

        const dumpText = await response.text()
        expect(dumpText.startsWith('SQLite format 3\0')).toBe(true)
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

    it('handles empty databases (no tables)', async () => {
        vi.mocked(executeOperation).mockResolvedValueOnce([])

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)

        expect(response.headers.get('Content-Type')).toBe(
            'application/x-sqlite3'
        )
        const dumpText = await response.text()
        expect(dumpText).toBe('SQLite format 3\0')
    })

    it('handles tables with a schema but no rows', async () => {
        mockSchema([
            {
                name: 'users',
                schema: 'CREATE TABLE users (id INTEGER, name TEXT)',
                rows: [],
            },
        ])

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)
        const dumpText = await response.text()
        expect(dumpText).toContain(
            'CREATE TABLE users (id INTEGER, name TEXT);'
        )
        expect(dumpText).not.toContain('INSERT INTO users VALUES')
    })

    it('escapes single quotes in string values', async () => {
        mockSchema([
            {
                name: 'users',
                schema: 'CREATE TABLE users (id INTEGER, bio TEXT)',
                rows: [{ id: 1, bio: "Alice's adventure" }],
            },
        ])

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)
        const dumpText = await response.text()
        expect(dumpText).toContain(
            "INSERT INTO users VALUES (1, 'Alice''s adventure');"
        )
    })

    it('emits NULL for null/undefined columns instead of literal text', async () => {
        mockSchema([
            {
                name: 't',
                schema: 'CREATE TABLE t (a INTEGER, b TEXT)',
                rows: [{ a: 1, b: null }],
            },
        ])

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)
        const dumpText = await response.text()
        expect(dumpText).toContain('INSERT INTO t VALUES (1, NULL);')
    })

    it('uses parameterised LIMIT/OFFSET to page through table data', async () => {
        mockSchema([
            {
                name: 'users',
                schema: 'CREATE TABLE users (id INTEGER)',
                rows: [{ id: 1 }],
            },
        ])

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)
        await response.text()

        const dataCall = vi
            .mocked(executeOperation)
            .mock.calls.find(([qs]) =>
                qs[0].sql.startsWith('SELECT * FROM users')
            )
        expect(dataCall).toBeDefined()
        expect(dataCall![0][0].sql).toContain('LIMIT ? OFFSET ?')
        expect(dataCall![0][0].params).toEqual([1000, 0])
    })

    it('propagates database errors mid-stream by erroring the body', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        // Streaming responses commit headers before any I/O runs, so a
        // mid-export DB failure can no longer manifest as a 500. Instead the
        // body stream errors — clients see a truncated download with a
        // network-level failure. Verify by reading directly from the stream
        // reader, which surfaces the underlying error reliably across runtimes.
        vi.mocked(executeOperation).mockRejectedValue(
            new Error('Database Error')
        )

        const response = await dumpDatabaseRoute(mockDataSource, mockConfig)
        const reader = response.body!.getReader()
        let caught: Error | undefined
        try {
            // Drain until the stream closes or errors.
            // eslint-disable-next-line no-constant-condition
            while (true) {
                const { done } = await reader.read()
                if (done) break
            }
        } catch (e) {
            caught = e as Error
        }
        expect(caught?.message).toBe('Database Error')
    })
})
