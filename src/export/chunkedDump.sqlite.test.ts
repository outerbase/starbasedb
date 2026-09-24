import { createClient, type Client } from '@libsql/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { executeOperation } from './index'
import {
    ChunkedDumpEngine,
    DEFAULT_DUMP_OPTIONS,
    DUMP_STATE_KEY,
    type DumpState,
} from './chunkedDump'
import type { DataSource } from '../types'
import type { StarbaseDBConfiguration } from '../handler'

vi.mock('./index', () => ({
    executeOperation: vi.fn(),
}))

const makeStorage = () => {
    const values = new Map<string, unknown>()
    return {
        get: vi.fn(async <T>(key: string) => values.get(key) as T),
        put: vi.fn(async (key: string, value: unknown) => {
            values.set(key, value)
        }),
        delete: vi.fn(async (key: string) => {
            values.delete(key)
        }),
    }
}

const makeDataSource = (): DataSource =>
    ({ source: 'internal', rpc: {} }) as unknown as DataSource

const makeConfig = (): StarbaseDBConfiguration => ({ role: 'admin' })

describe('ChunkedDumpEngine with SQLite', () => {
    let client: Client
    let storage: ReturnType<typeof makeStorage>
    let queries: { sql: string; params?: unknown[] }[]

    beforeEach(async () => {
        client = createClient({ url: 'file::memory:' })
        storage = makeStorage()
        queries = []
        vi.mocked(executeOperation).mockImplementation(async (batch: any[]) => {
            const query = batch[0]
            queries.push(query)
            const result = await client.execute({
                sql: query.sql,
                args: query.params ?? [],
            })
            return result.rows as Record<string, unknown>[]
        })
    })

    afterEach(() => {
        client.close()
        vi.clearAllMocks()
    })

    it('keeps negative, zero, and positive rowids and handles composite WITHOUT ROWID keys', async () => {
        await client.execute(
            'CREATE TABLE "odd names" (id INTEGER, value TEXT)'
        )
        await client.execute({
            sql: 'INSERT INTO "odd names" (rowid, id, value) VALUES (?, ?, ?), (?, ?, ?), (?, ?, ?)',
            args: [-7, 10, 'negative', 0, 20, 'zero', 9, 30, 'positive'],
        })
        await client.execute(
            'CREATE TABLE "without rowid" ("key one" TEXT NOT NULL, part INTEGER NOT NULL, value TEXT, PRIMARY KEY ("key one", part)) WITHOUT ROWID'
        )
        await client.execute({
            sql: 'INSERT INTO "without rowid" ("key one", part, value) VALUES (?, ?, ?), (?, ?, ?)',
            args: ['a', 2, 'a2', 'a', 1, 'a1'],
        })
        await client.execute('CREATE TABLE "shadow" ("rowid" TEXT, value TEXT)')
        await client.execute({
            sql: 'INSERT INTO "shadow" ("rowid", value) VALUES (?, ?), (?, ?)',
            args: ['first', 1, 'second', 2],
        })

        const engine = new ChunkedDumpEngine(
            storage as unknown as DurableObjectStorage,
            undefined,
            makeDataSource(),
            makeConfig(),
            { ...DEFAULT_DUMP_OPTIONS, rowsPerBatch: 2, chunkTargetBytes: 80 }
        )
        let state = await engine.startDump()
        for (let i = 0; i < 20 && !state.completedAt; i++) {
            state = await engine.runCycle()
        }
        expect(state.completedAt).toBeDefined()
        expect(state.totalRows).toBe(7)

        const firstDataQuery = queries.find(
            (query) =>
                query.sql.includes('FROM "odd names"') &&
                query.sql.includes('ORDER BY')
        )
        expect(firstDataQuery?.sql).not.toContain('WHERE "rowid" >')
        expect(
            queries.some(
                (query) =>
                    query.sql.includes('FROM "odd names"') &&
                    query.sql.includes('WHERE "rowid" > ?') &&
                    query.params?.[0] === 0
            )
        ).toBe(true)
        expect(
            queries.some(
                (query) =>
                    query.sql.includes('FROM "without rowid"') &&
                    query.sql.includes('("key one", "part") > (?, ?)')
            )
        ).toBe(true)
        expect(
            queries.some(
                (query) =>
                    query.sql.includes('FROM "shadow"') &&
                    query.sql.includes('ORDER BY "_rowid_"')
            )
        ).toBe(true)

        const stream = await engine.assembleDump(state)
        expect(stream).not.toBeNull()
        const dump = await new Response(stream as ReadableStream).text()
        expect(dump).toContain('INSERT INTO "odd names"')
        expect(dump).toContain('negative')
        expect(dump).toContain('zero')
        expect(dump).toContain('positive')
        expect(dump).toContain('INSERT INTO "without rowid"')
        expect(dump).toContain('a1')
        expect(dump).toContain('a2')
        expect(dump).toContain('INSERT INTO "shadow"')
        const persisted = (await storage.get(DUMP_STATE_KEY)) as
            | DumpState
            | undefined
        expect(persisted?.completedAt).toBeDefined()
    })
})
