import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ReplicatePlugin } from './index'
import { executeQuery } from '../../src/operation'

vi.mock('../../src/operation', () => ({
    executeQuery: vi.fn(),
}))

// The plugin pulls from the external source via operation.executeQuery and
// writes to the internal DO SQLite via dataSource.rpc.executeQuery.
const externalQuery: any = vi.mocked(executeQuery)

function makeDataSource() {
    return {
        source: 'external',
        external: { dialect: 'postgresql' },
        rpc: { executeQuery: vi.fn(async () => []) },
    } as any
}

function injectContext(plugin: ReplicatePlugin, dataSource: any) {
    ;(plugin as any).dataSource = dataSource
    ;(plugin as any).config = { role: 'admin' }
}

beforeEach(() => {
    externalQuery.mockReset()
})

describe('ReplicatePlugin', () => {
    it('instantiates with defaults', () => {
        const p = new ReplicatePlugin()
        expect(p.name).toBe('starbasedb:replicate')
        expect(p.pathPrefix).toBe('/replicate')
        expect((p as any).batchSize).toBe(1000)
    })

    it('honours custom tables and batchSize', () => {
        const p = new ReplicatePlugin({
            tables: [{ table: 'users', cursorColumn: 'id' }],
            batchSize: 50,
        })
        expect((p as any).tables).toHaveLength(1)
        expect((p as any).batchSize).toBe(50)
    })

    it('throws when dataSource is missing', async () => {
        await expect(new ReplicatePlugin().runReplication()).rejects.toThrow(
            'dataSource not available'
        )
    })

    it('throws when no external source is configured', async () => {
        const p = new ReplicatePlugin()
        injectContext(p, {
            source: 'internal',
            rpc: { executeQuery: vi.fn(async () => []) },
        })
        await expect(p.runReplication()).rejects.toThrow(
            'No external data source configured'
        )
    })

    it('incrementally replicates with keyset pagination (no OFFSET)', async () => {
        const p = new ReplicatePlugin({
            tables: [{ table: 'users', cursorColumn: 'id' }],
            batchSize: 2,
        })
        const ds = makeDataSource()
        injectContext(p, ds)

        externalQuery
            .mockResolvedValueOnce([
                { id: 1, name: 'a' },
                { id: 2, name: 'b' },
            ])
            .mockResolvedValueOnce([{ id: 3, name: 'c' }])

        const results = await p.runReplication()

        expect(results).toEqual([
            { table: 'users', mode: 'incremental', rowsReplicated: 3 },
        ])

        // first batch: fresh, so no WHERE — ordered by the cursor, LIMIT only
        const firstSql = externalQuery.mock.calls[0][0].sql
        expect(firstSql).toContain('ORDER BY "id" ASC LIMIT 2')
        expect(firstSql).not.toContain('OFFSET')

        // second batch: keyset cursor taken from the last row of batch 1
        const second = externalQuery.mock.calls[1][0]
        expect(second.sql).toContain('WHERE "id" > ?')
        expect(second.sql).not.toContain('OFFSET')
        expect(second.params).toEqual([2])

        // every pulled row landed in the internal database
        const inserts = ds.rpc.executeQuery.mock.calls
            .map((c: any) => c[0].sql)
            .filter((s: string) =>
                s.includes('INSERT OR REPLACE INTO "users"')
            )
        expect(inserts).toHaveLength(3)
    })

    it('fully re-syncs tables without a cursor column using OFFSET', async () => {
        const p = new ReplicatePlugin({
            tables: [{ table: 'settings' }],
            batchSize: 2,
        })
        injectContext(p, makeDataSource())

        externalQuery
            .mockResolvedValueOnce([{ k: 'a' }, { k: 'b' }])
            .mockResolvedValueOnce([])

        const results = await p.runReplication()

        expect(results[0].mode).toBe('full')
        expect(externalQuery.mock.calls[0][0].sql).toContain(
            'LIMIT 2 OFFSET 0'
        )
    })

    it('coerces booleans, dates and nulls for SQLite', async () => {
        const p = new ReplicatePlugin({
            tables: [{ table: 'events', cursorColumn: 'id' }],
            batchSize: 10,
        })
        const ds = makeDataSource()
        injectContext(p, ds)

        const when = new Date('2026-01-02T03:04:05.000Z')
        externalQuery.mockResolvedValueOnce([
            { id: 1, active: true, removed: false, note: null, at: when },
        ])

        await p.runReplication()

        const insert = ds.rpc.executeQuery.mock.calls
            .map((c: any) => c[0])
            .find((q: any) =>
                q.sql.includes('INSERT OR REPLACE INTO "events"')
            )
        expect(insert.params).toEqual([1, 1, 0, null, when.toISOString()])
    })
})
