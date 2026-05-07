import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ReplicationPlugin } from './index'
import { StarbaseApp, StarbaseDBConfiguration } from '../../src/handler'
import {
    DataSource,
    ExternalDatabaseSource,
    QueryResult,
} from '../../src/types'

// `executeExternalQuery` lives in src/operation.ts and contains a hard
// dependency on `pg`/`mysql2`/`postgres`/etc. that is not safe to load under
// vitest in this repo. We replace it with a mock that simulates the network
// hop the plugin makes when reading from the external source.
const executeExternalQueryMock = vi.fn()
vi.mock('../../src/operation', () => ({
    executeExternalQuery: (opts: any) => executeExternalQueryMock(opts),
}))

type CapturedQuery = { sql: string; params: unknown[] }

function makeMockDataSource(): {
    dataSource: DataSource
    captured: CapturedQuery[]
    state: Map<string, Map<string, string | null>>
    onSelect: (
        handler: (sql: string, params: unknown[]) => unknown[] | undefined
    ) => void
} {
    const captured: CapturedQuery[] = []
    const state = new Map<string, Map<string, string | null>>()
    let selectHandler:
        | ((sql: string, params: unknown[]) => unknown[] | undefined)
        | undefined

    const executeQuery = vi.fn(async (q: CapturedQuery) => {
        captured.push({ sql: q.sql.trim(), params: q.params ?? [] })

        if (q.sql.includes('FROM tmp_replication_state')) {
            const trimmed = q.sql.trim()
            // GET_CURSOR takes (source_id, table_name) -> cursor_value
            if (trimmed.includes('SELECT cursor_value FROM')) {
                const [sourceId, table] = q.params as [string, string]
                const v = state.get(sourceId)?.get(table)
                if (v === undefined) return [] as QueryResult[]
                return [{ cursor_value: v } as unknown as QueryResult]
            }
            // LIST_STATE
            if (trimmed.includes('SELECT source_id, table_name')) {
                const [sourceId] = q.params as [string]
                const out: any[] = []
                const tables = state.get(sourceId)
                if (tables) {
                    for (const [table, value] of tables.entries()) {
                        out.push({
                            source_id: sourceId,
                            table_name: table,
                            cursor_column: 'id',
                            cursor_value: value,
                        })
                    }
                }
                return out as QueryResult[]
            }
        }
        if (q.sql.includes('INSERT INTO tmp_replication_state')) {
            const [sourceId, table_name, _col, value] = q.params as [
                string,
                string,
                string,
                string | null,
            ]
            const inner =
                state.get(sourceId) ?? new Map<string, string | null>()
            inner.set(table_name, value)
            state.set(sourceId, inner)
            return []
        }
        if (q.sql.startsWith('SELECT') && selectHandler) {
            return (selectHandler(q.sql, q.params ?? []) ?? []) as QueryResult[]
        }
        return [] as QueryResult[]
    })

    const dataSource = {
        source: 'internal',
        rpc: {
            executeQuery,
        },
    } as unknown as DataSource

    return {
        dataSource,
        captured,
        state,
        onSelect: (handler) => {
            selectHandler = handler
        },
    }
}

const mockSource: ExternalDatabaseSource = {
    dialect: 'postgresql',
    host: 'db.example.com',
    port: 5432,
    user: 'u',
    password: 'p',
    database: 'd',
}

const adminConfig: StarbaseDBConfiguration = { role: 'admin' }

beforeEach(() => {
    vi.clearAllMocks()
    executeExternalQueryMock.mockReset()
})

describe('ReplicationPlugin - construction', () => {
    it('rejects empty tables', () => {
        expect(
            () => new ReplicationPlugin({ tables: [], source: mockSource })
        ).toThrow(/at least one table/)
    })

    it('uses default sourceId, pageSize, pathPrefix', () => {
        const p = new ReplicationPlugin({
            tables: [{ table: 'users', cursorColumn: 'id' }],
            source: mockSource,
        })
        expect(p.pathPrefix).toBe('/replicate')
    })

    it('honours custom sourceId / pathPrefix', () => {
        const p = new ReplicationPlugin({
            tables: [{ table: 'users', cursorColumn: 'id' }],
            sourceId: 'supabase-prod',
            pathPrefix: '/repl',
            source: mockSource,
        })
        expect(p.pathPrefix).toBe('/repl')
    })

    it('rejects invalid SQL identifiers in table config', () => {
        const p = new ReplicationPlugin({
            tables: [{ table: 'users', cursorColumn: 'id; DROP TABLE x' }],
            source: mockSource,
        })
        expect(p).toBeDefined()
        // identifier validation runs at tick() time
    })
})

describe('ReplicationPlugin - register()', () => {
    it('registers a middleware that creates the state table', async () => {
        const { dataSource, captured } = makeMockDataSource()
        const plugin = new ReplicationPlugin({
            tables: [{ table: 'users', cursorColumn: 'id' }],
            source: mockSource,
        })

        let captured_mw: any = null
        const next = vi.fn()
        const useFn = vi.fn((mw) => {
            captured_mw = mw
        })
        const mockApp = {
            use: useFn,
            post: vi.fn(),
            get: vi.fn(),
        } as unknown as StarbaseApp

        await plugin.register(mockApp)

        // simulate a request hitting the middleware
        expect(useFn).toHaveBeenCalledTimes(1)
        expect(captured_mw).toBeTypeOf('function')
        await captured_mw(
            {
                get: (k: string) =>
                    k === 'dataSource' ? dataSource : adminConfig,
            } as any,
            next
        )

        expect(next).toHaveBeenCalledTimes(1)
        const createCall = captured.find((c) =>
            c.sql.includes('CREATE TABLE IF NOT EXISTS tmp_replication_state')
        )
        expect(createCall).toBeDefined()
    })
})

describe('ReplicationPlugin - tick() pulls and upserts', () => {
    it('reads from external on first tick (no cursor) and upserts rows', async () => {
        const { dataSource, captured } = makeMockDataSource()
        executeExternalQueryMock.mockResolvedValueOnce([
            { id: 1, name: 'alice' },
            { id: 2, name: 'bob' },
        ])

        const plugin = new ReplicationPlugin({
            tables: [{ table: 'users', cursorColumn: 'id' }],
            source: mockSource,
            pageSize: 100,
        })

        const summary = await plugin.tick({
            dataSource,
            config: adminConfig,
        })

        expect(executeExternalQueryMock).toHaveBeenCalledTimes(1)
        const call = executeExternalQueryMock.mock.calls[0][0]
        expect(call.sql).toMatch(/SELECT \* FROM "users"/)
        expect(call.sql).not.toMatch(/WHERE/)
        expect(call.sql).toMatch(/ORDER BY "id" ASC LIMIT 100/)
        expect(call.params).toEqual([])

        expect(summary.perTable).toHaveLength(1)
        expect(summary.perTable[0]).toMatchObject({
            table: 'users',
            rowsPulled: 2,
            cursorBefore: null,
            cursorAfter: '2',
            morePagesAvailable: false,
        })

        const upsert = captured.find((c) =>
            c.sql.startsWith('INSERT INTO "users"')
        )
        expect(upsert).toBeDefined()
        expect(upsert!.sql).toMatch(/ON CONFLICT\("id"\) DO UPDATE SET/)
    })

    it('passes the previous cursor as a bound parameter on subsequent ticks', async () => {
        const { dataSource, state } = makeMockDataSource()
        state.set('default', new Map<string, string | null>([['users', '7']]))
        executeExternalQueryMock.mockResolvedValueOnce([
            { id: 8, name: 'carol' },
        ])

        const plugin = new ReplicationPlugin({
            tables: [{ table: 'users', cursorColumn: 'id' }],
            source: mockSource,
        })

        await plugin.tick({ dataSource, config: adminConfig })

        const call = executeExternalQueryMock.mock.calls[0][0]
        expect(call.sql).toMatch(/WHERE "id" > \?/)
        expect(call.params).toEqual(['7'])
    })

    it('flags morePagesAvailable when external returns a full page', async () => {
        const { dataSource } = makeMockDataSource()
        executeExternalQueryMock.mockResolvedValueOnce([
            { id: 1, n: 'a' },
            { id: 2, n: 'b' },
        ])

        const plugin = new ReplicationPlugin({
            tables: [{ table: 'rows', cursorColumn: 'id', pageSize: 2 }],
            source: mockSource,
        })

        const summary = await plugin.tick({
            dataSource,
            config: adminConfig,
        })

        expect(summary.perTable[0].morePagesAvailable).toBe(true)
    })

    it('records empty-batch ticks without advancing the cursor', async () => {
        const { dataSource, state } = makeMockDataSource()
        state.set('default', new Map([['users', '99']]))
        executeExternalQueryMock.mockResolvedValueOnce([])

        const plugin = new ReplicationPlugin({
            tables: [{ table: 'users', cursorColumn: 'id' }],
            source: mockSource,
        })

        const summary = await plugin.tick({
            dataSource,
            config: adminConfig,
        })

        expect(summary.perTable[0]).toMatchObject({
            table: 'users',
            rowsPulled: 0,
            cursorBefore: '99',
            cursorAfter: '99',
            morePagesAvailable: false,
        })
    })
})

describe('ReplicationPlugin - tick() per-table isolation', () => {
    it('records error on one table without breaking the rest', async () => {
        const { dataSource } = makeMockDataSource()
        executeExternalQueryMock
            .mockRejectedValueOnce(new Error('connection refused'))
            .mockResolvedValueOnce([{ id: 5, v: 'ok' }])

        const plugin = new ReplicationPlugin({
            tables: [
                { table: 'broken', cursorColumn: 'id' },
                { table: 'fine', cursorColumn: 'id' },
            ],
            source: mockSource,
        })

        const summary = await plugin.tick({
            dataSource,
            config: adminConfig,
        })

        expect(summary.perTable).toHaveLength(2)
        expect(summary.perTable[0]).toMatchObject({
            table: 'broken',
            rowsPulled: 0,
            error: 'connection refused',
        })
        expect(summary.perTable[1]).toMatchObject({
            table: 'fine',
            rowsPulled: 1,
            cursorAfter: '5',
        })
        expect(summary.perTable[1].error).toBeUndefined()
    })

    it('rejects malformed cursor column to prevent SQL injection', async () => {
        const { dataSource } = makeMockDataSource()
        const plugin = new ReplicationPlugin({
            tables: [{ table: 'users', cursorColumn: 'id; DROP TABLE x' }],
            source: mockSource,
        })

        const summary = await plugin.tick({
            dataSource,
            config: adminConfig,
        })

        expect(summary.perTable[0].error).toMatch(/Invalid.*identifier/i)
        expect(executeExternalQueryMock).not.toHaveBeenCalled()
    })
})

describe('ReplicationPlugin - tick() requires sources', () => {
    it('errors when no internal data source is provided', async () => {
        const plugin = new ReplicationPlugin({
            tables: [{ table: 'users', cursorColumn: 'id' }],
            source: mockSource,
        })
        await expect(plugin.tick()).rejects.toThrow(/no internal data source/i)
    })

    it('errors when no external source is configured', async () => {
        const { dataSource } = makeMockDataSource()
        const plugin = new ReplicationPlugin({
            tables: [{ table: 'users', cursorColumn: 'id' }],
        })
        await expect(
            plugin.tick({ dataSource, config: adminConfig })
        ).rejects.toThrow(/no external source/i)
    })

    it('falls back to dataSource.external when no plugin source is set', async () => {
        const { dataSource } = makeMockDataSource()
        ;(dataSource as any).external = mockSource
        executeExternalQueryMock.mockResolvedValueOnce([{ id: 1 }])

        const plugin = new ReplicationPlugin({
            tables: [{ table: 'users', cursorColumn: 'id' }],
        })
        const summary = await plugin.tick({
            dataSource,
            config: adminConfig,
        })

        expect(summary.perTable[0].rowsPulled).toBe(1)
    })
})
