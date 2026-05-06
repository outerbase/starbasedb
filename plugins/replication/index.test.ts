import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ReplicationPlugin } from './index'
import { buildCreateTable, buildInsert } from './sql'
import type {
    ColumnDef,
    PullPage,
    ReplicationAdapter,
    ReplicationConfig,
    SqlScalar,
} from './types'
import type { DataSource } from '../../src/types'

/**
 * In-memory mock of the DO RPC surface. We don't actually run SQL — we
 * record every call and answer SELECTs from per-table maps so the plugin's
 * watermark/log behaviour is observable without standing up a real DO.
 */
class FakeRpc {
    public calls: { sql: string; params: unknown[] }[] = []
    private watermarks = new Map<string, string | null>()

    executeQuery = vi.fn(async (q: { sql: string; params?: unknown[] }) => {
        const params = q.params ?? []
        this.calls.push({ sql: q.sql, params })

        // Watermark UPSERT
        if (/INSERT INTO _starbase_replication_watermarks/.test(q.sql)) {
            const [source, table, , value] = params as [
                string,
                string,
                string,
                string | null,
            ]
            this.watermarks.set(`${source}::${table}`, value ?? null)
            return []
        }

        // Watermark SELECT
        if (
            /SELECT last_value FROM _starbase_replication_watermarks/.test(
                q.sql
            )
        ) {
            const [source, table] = params as [string, string]
            const v = this.watermarks.get(`${source}::${table}`)
            return v === undefined ? [] : [{ last_value: v }]
        }

        // Status SELECT
        if (/SELECT source,/.test(q.sql)) return []

        return []
    })
}

function makeDataSource(): DataSource {
    const rpc = new FakeRpc()
    return { rpc, source: 'internal' } as unknown as DataSource
}

class MockAdapter implements ReplicationAdapter {
    public describeCalls = 0
    public closeCalls = 0
    constructor(
        private columns: ColumnDef[],
        private pages: PullPage[],
        public errorOn?: 'describe' | 'pull'
    ) {}

    async describe(_table: string): Promise<ColumnDef[]> {
        this.describeCalls++
        if (this.errorOn === 'describe') throw new Error('describe blew up')
        return this.columns
    }

    async *pull(_opts: {
        table: string
        watermarkColumn: string
        watermark: SqlScalar | null
        pageSize: number
    }): AsyncIterable<PullPage> {
        if (this.errorOn === 'pull') throw new Error('pull blew up')
        for (const p of this.pages) yield p
    }

    async close(): Promise<void> {
        this.closeCalls++
    }
}

function findRpc(ds: DataSource): FakeRpc {
    return ds.rpc as unknown as FakeRpc
}

describe('ReplicationPlugin — buildCreateTable', () => {
    it('renders a CREATE TABLE with the reflected columns and PK', () => {
        const sql = buildCreateTable('users', [
            { name: 'id', sqliteType: 'INTEGER', primaryKey: true },
            { name: 'email', sqliteType: 'TEXT' },
            { name: 'updated_at', sqliteType: 'TEXT' },
        ])
        expect(sql).toContain('CREATE TABLE IF NOT EXISTS "users"')
        expect(sql).toContain('"id" INTEGER')
        expect(sql).toContain('"email" TEXT')
        expect(sql).toContain('PRIMARY KEY ("id")')
    })

    it('omits PRIMARY KEY clause when no column is flagged', () => {
        const sql = buildCreateTable('events', [
            { name: 'id', sqliteType: 'INTEGER' },
            { name: 'payload', sqliteType: 'TEXT' },
        ])
        expect(sql).not.toContain('PRIMARY KEY')
    })

    it('throws on zero columns rather than emit invalid SQL', () => {
        expect(() => buildCreateTable('x', [])).toThrow(/zero columns/)
    })
})

describe('ReplicationPlugin — buildInsert', () => {
    it('uses INSERT OR REPLACE when a primary key is configured', () => {
        const sql = buildInsert('users', ['id', 'email'], true)
        expect(sql).toMatch(/^INSERT OR REPLACE/)
        expect(sql).toContain('("id", "email")')
        expect(sql).toContain('VALUES (?, ?)')
    })

    it('falls back to INSERT OR IGNORE for append-only tables', () => {
        const sql = buildInsert('events', ['id', 'payload'], false)
        expect(sql).toMatch(/^INSERT OR IGNORE/)
    })
})

describe('ReplicationPlugin — config parsing', () => {
    it('rejects non-array REPLICATION_CONFIG_JSON', () => {
        expect(
            () =>
                new ReplicationPlugin({
                    env: { REPLICATION_CONFIG_JSON: '{}' },
                })
        ).toThrow(/array of source configs/)
    })

    it('rejects malformed JSON', () => {
        expect(
            () =>
                new ReplicationPlugin({
                    env: { REPLICATION_CONFIG_JSON: 'not json' },
                })
        ).toThrow(/not valid JSON/)
    })

    it('rejects sources with non-positive intervalSeconds', () => {
        expect(
            () =>
                new ReplicationPlugin({
                    env: {
                        REPLICATION_CONFIG_JSON: JSON.stringify([
                            {
                                source: 'mock',
                                intervalSeconds: 0,
                                tables: [{ name: 't', watermark: 'id' }],
                            },
                        ]),
                    },
                })
        ).toThrow(/intervalSeconds/)
    })

    it('parses a valid config without throwing', () => {
        const plugin = new ReplicationPlugin({
            config: [
                {
                    source: 'mock',
                    intervalSeconds: 60,
                    tables: [
                        {
                            name: 'users',
                            watermark: 'updated_at',
                            primaryKey: 'id',
                        },
                    ],
                },
            ],
        })
        expect(plugin).toBeInstanceOf(ReplicationPlugin)
    })

    it('treats missing config as a disabled (no-op) plugin', async () => {
        const plugin = new ReplicationPlugin()
        const ds = makeDataSource()
        const summary = await plugin.runDue(ds)
        expect(summary).toEqual([])
    })
})

describe('ReplicationPlugin — runDue', () => {
    let config: ReplicationConfig
    let cols: ColumnDef[]
    beforeEach(() => {
        cols = [
            { name: 'id', sqliteType: 'INTEGER', primaryKey: true },
            { name: 'email', sqliteType: 'TEXT' },
            { name: 'updated_at', sqliteType: 'TEXT' },
        ]
        config = [
            {
                source: 'mock',
                intervalSeconds: 60,
                tables: [
                    {
                        name: 'users',
                        watermark: 'updated_at',
                        primaryKey: 'id',
                    },
                ],
            },
        ]
    })

    it('advances the watermark after a successful pull', async () => {
        const adapter = new MockAdapter(cols, [
            {
                rows: [
                    { id: 1, email: 'a@x', updated_at: '2026-01-01T00:00:00Z' },
                    { id: 2, email: 'b@x', updated_at: '2026-01-02T00:00:00Z' },
                ],
                nextWatermark: '2026-01-02T00:00:00Z',
            },
        ])

        const plugin = new ReplicationPlugin({
            config,
            adapterFactory: () => adapter,
        })
        const ds = makeDataSource()
        const summary = await plugin.runDue(ds)

        expect(summary).toEqual([
            { source: 'mock', table: 'users', rows: 2, ok: true },
        ])
        const rpc = findRpc(ds)
        const wm = rpc.calls.find((c) =>
            /INSERT INTO _starbase_replication_watermarks/.test(c.sql)
        )
        expect(wm?.params[3]).toBe('2026-01-02T00:00:00Z')
    })

    it('does not re-pull rows already covered by the watermark', async () => {
        const adapter = new MockAdapter(cols, [
            {
                rows: [
                    { id: 1, email: 'a@x', updated_at: '2026-01-01T00:00:00Z' },
                ],
                nextWatermark: '2026-01-01T00:00:00Z',
            },
        ])
        const pullSpy = vi.spyOn(adapter, 'pull')

        const plugin = new ReplicationPlugin({
            config,
            adapterFactory: () => adapter,
        })
        const ds = makeDataSource()

        await plugin.runDue(ds, { now: 0 })
        // Second tick at +30s — interval is 60s so this should be a no-op.
        const summary = await plugin.runDue(ds, { now: 30_000 })
        expect(summary).toEqual([])
        expect(pullSpy).toHaveBeenCalledTimes(1)

        // Third tick at +120s — interval has elapsed, should re-poll with the
        // stored watermark passed in.
        await plugin.runDue(ds, { now: 120_000 })
        expect(pullSpy).toHaveBeenCalledTimes(2)
        expect(pullSpy.mock.calls[1][0].watermark).toBe('2026-01-01T00:00:00Z')
    })

    it('issues CREATE TABLE only on the first sync per table', async () => {
        const adapter = new MockAdapter(cols, [
            {
                rows: [{ id: 1, email: 'a@x', updated_at: '2026-01-01' }],
                nextWatermark: '2026-01-01',
            },
        ])
        const plugin = new ReplicationPlugin({
            config,
            adapterFactory: () => adapter,
        })
        const ds = makeDataSource()
        await plugin.runDue(ds, { now: 0, force: true })
        await plugin.runDue(ds, { now: 1_000_000, force: true })

        expect(adapter.describeCalls).toBe(1)
        const rpc = findRpc(ds)
        const creates = rpc.calls.filter((c) =>
            /CREATE TABLE IF NOT EXISTS "users"/.test(c.sql)
        )
        expect(creates.length).toBe(1)
    })

    it('runs multiple tables independently — one failure does not block others', async () => {
        const goodCols: ColumnDef[] = [
            { name: 'id', sqliteType: 'INTEGER', primaryKey: true },
            { name: 'val', sqliteType: 'TEXT' },
        ]
        const goodAdapter = new MockAdapter(goodCols, [
            { rows: [{ id: 1, val: 'a' }], nextWatermark: 1 },
        ])
        const badAdapter = new MockAdapter(goodCols, [], 'pull')

        const multiConfig: ReplicationConfig = [
            {
                source: 'mock',
                intervalSeconds: 60,
                tables: [{ name: 'good', watermark: 'id' }],
            },
            {
                source: 'postgres',
                conn: 'irrelevant',
                intervalSeconds: 60,
                tables: [{ name: 'bad', watermark: 'id' }],
            },
        ]
        const plugin = new ReplicationPlugin({
            config: multiConfig,
            adapterFactory: (s) =>
                s.source === 'mock' ? goodAdapter : badAdapter,
        })
        const ds = makeDataSource()
        const summary = await plugin.runDue(ds)

        const good = summary.find((s) => s.table === 'good')
        const bad = summary.find((s) => s.table === 'bad')
        expect(good?.ok).toBe(true)
        expect(good?.rows).toBe(1)
        expect(bad?.ok).toBe(false)
        expect(bad?.error).toMatch(/pull blew up/)

        // Failure should be recorded in the audit log.
        const rpc = findRpc(ds)
        const errLog = rpc.calls.find(
            (c) =>
                /INSERT INTO _starbase_replication_log/.test(c.sql) &&
                (c.params as unknown[])[2] === 'bad'
        )
        expect(errLog).toBeDefined()
        expect((errLog!.params as unknown[])[4]).toBe(0) // ok = false
    })

    it('does not advance the watermark when the adapter throws', async () => {
        const adapter = new MockAdapter(cols, [], 'pull')
        const plugin = new ReplicationPlugin({
            config,
            adapterFactory: () => adapter,
        })
        const ds = makeDataSource()
        await plugin.runDue(ds)
        const rpc = findRpc(ds)
        const wmUpserts = rpc.calls.filter((c) =>
            /INSERT INTO _starbase_replication_watermarks/.test(c.sql)
        )
        expect(wmUpserts).toHaveLength(0)
    })

    it('streams multi-page pulls and persists watermark per page', async () => {
        const pageCols: ColumnDef[] = [
            { name: 'id', sqliteType: 'INTEGER', primaryKey: true },
        ]
        const adapter = new MockAdapter(pageCols, [
            { rows: [{ id: 1 }, { id: 2 }], nextWatermark: 2 },
            { rows: [{ id: 3 }, { id: 4 }], nextWatermark: 4 },
        ])
        const pageConfig: ReplicationConfig = [
            {
                source: 'mock',
                intervalSeconds: 60,
                tables: [{ name: 't', watermark: 'id', primaryKey: 'id' }],
            },
        ]
        const plugin = new ReplicationPlugin({
            config: pageConfig,
            adapterFactory: () => adapter,
        })
        const ds = makeDataSource()
        await plugin.runDue(ds)
        const rpc = findRpc(ds)
        const wmUpserts = rpc.calls.filter((c) =>
            /INSERT INTO _starbase_replication_watermarks/.test(c.sql)
        )
        // One upsert per page.
        expect(wmUpserts.length).toBe(2)
        expect(wmUpserts[0].params[3]).toBe('2')
        expect(wmUpserts[1].params[3]).toBe('4')
    })
})

describe('ReplicationPlugin — close', () => {
    it('closes every adapter that has been instantiated', async () => {
        const a = new MockAdapter([{ name: 'id', sqliteType: 'INTEGER' }], [])
        const plugin = new ReplicationPlugin({
            config: [
                {
                    source: 'mock',
                    intervalSeconds: 60,
                    tables: [{ name: 't', watermark: 'id' }],
                },
            ],
            adapterFactory: () => a,
        })
        const ds = makeDataSource()
        await plugin.runDue(ds)
        await plugin.close()
        expect(a.closeCalls).toBe(1)
    })
})
