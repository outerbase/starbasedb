import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ReplicationPlugin } from './index'
import { ReplicationConfigurationError } from './utils'

// In-memory stand-in for the internal Durable Object SQLite database. It understands
// just enough of the plugin's SQL to track checkpoints and record upserts.
function makeRpc() {
    const checkpoints = new Map<
        string,
        { last_value: string | null; updated_at: number }
    >()
    const upserts: { sql: string; params: unknown[] }[] = []

    const executeQuery = vi.fn(
        async ({ sql, params = [] }: { sql: string; params?: unknown[] }) => {
            if (sql.includes('CREATE TABLE')) {
                return []
            }
            if (sql.includes('SELECT last_value')) {
                const cp = checkpoints.get(params[0] as string)
                return cp ? [{ last_value: cp.last_value }] : []
            }
            if (sql.includes('MAX(updated_at)')) {
                const values = [...checkpoints.values()]
                return [
                    {
                        last_pulled_at: values.length
                            ? Math.max(...values.map((c) => c.updated_at))
                            : null,
                    },
                ]
            }
            if (sql.includes('INTO tmp_replication_checkpoints')) {
                checkpoints.set(params[0] as string, {
                    last_value: params[1] as string,
                    updated_at: params[2] as number,
                })
                return []
            }
            upserts.push({ sql, params })
            return []
        }
    )

    return { rpc: { executeQuery }, checkpoints, upserts }
}

function makePlugin(
    rows: Record<string, unknown>[],
    readSpy = vi.fn(async () => rows)
) {
    const plugin = new ReplicationPlugin({
        tables: [{ name: 'users', trackBy: 'id' }],
        intervalSeconds: 0,
        readExternal: readSpy,
    })
    const store = makeRpc()
    ;(plugin as any).dataSource = {
        rpc: store.rpc,
        source: 'internal',
        external: {},
    }
    ;(plugin as any).config = { role: 'admin' }
    return { plugin, store, readSpy }
}

describe('ReplicationPlugin - configuration', () => {
    it('should reject construction with no tables', () => {
        expect(() => new ReplicationPlugin({ tables: [] })).toThrowError(
            ReplicationConfigurationError
        )
    })

    it('should reject a non-positive batchSize', () => {
        expect(
            () =>
                new ReplicationPlugin({
                    tables: [{ name: 'users', trackBy: 'id' }],
                    batchSize: 0,
                })
        ).toThrowError(ReplicationConfigurationError)
    })

    it('should name itself for the registry', () => {
        const plugin = new ReplicationPlugin({
            tables: [{ name: 'users', trackBy: 'id' }],
        })
        expect(plugin.name).toBe('starbasedb:replication')
        expect(plugin.pathPrefix).toBe('/replication')
    })
})

describe('ReplicationPlugin - pull', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('should seed the full table on the first pull (no checkpoint)', async () => {
        const rows = [
            { id: 1, name: 'Ada' },
            { id: 2, name: 'Linus' },
        ]
        const { plugin, store, readSpy } = makePlugin(rows)

        const result = await plugin.pull()

        // First pull must not filter — it seeds everything.
        const [sql] = readSpy.mock.calls[0]
        expect(sql).not.toContain('WHERE')

        expect(store.upserts).toHaveLength(2)
        expect(store.upserts[0].sql).toContain('INSERT OR REPLACE INTO users')
        expect(result).toEqual([{ table: 'users', rowsReplicated: 2 }])

        // Checkpoint advances to the highest tracked value, type-preserved as JSON.
        expect(store.checkpoints.get('users')?.last_value).toBe(
            JSON.stringify(2)
        )
    })

    it('should only fetch newer rows once a checkpoint exists', async () => {
        const { plugin, store, readSpy } = makePlugin([{ id: 1 }])
        await plugin.pull()

        // Subsequent pull should pass the stored checkpoint as a typed param.
        readSpy.mockResolvedValueOnce([{ id: 2 }])
        await plugin.pull()

        const [sql, params] = readSpy.mock.calls[1]
        expect(sql).toContain('WHERE id > ?')
        expect(params).toEqual([1])
        expect(store.checkpoints.get('users')?.last_value).toBe(
            JSON.stringify(2)
        )
    })

    it('should not advance the checkpoint or write when no new rows exist', async () => {
        const { plugin, store } = makePlugin([])

        const result = await plugin.pull()

        expect(store.upserts).toHaveLength(0)
        expect(store.checkpoints.has('users')).toBe(false)
        expect(result).toEqual([{ table: 'users', rowsReplicated: 0 }])
    })

    it('should throw when used before initialization', async () => {
        const plugin = new ReplicationPlugin({
            tables: [{ name: 'users', trackBy: 'id' }],
        })
        await expect(plugin.pull()).rejects.toThrowError(
            'ReplicationPlugin not properly initialized'
        )
    })

    it('should replicate multiple tables independently', async () => {
        const plugin = new ReplicationPlugin({
            tables: [
                { name: 'users', trackBy: 'id' },
                { name: 'orders', trackBy: 'created_at' },
            ],
            intervalSeconds: 0,
            readExternal: vi
                .fn()
                .mockResolvedValueOnce([{ id: 7 }])
                .mockResolvedValueOnce([
                    { created_at: '2024-05-01' },
                    { created_at: '2024-06-01' },
                ]),
        })
        const store = makeRpc()
        ;(plugin as any).dataSource = {
            rpc: store.rpc,
            source: 'internal',
            external: {},
        }
        ;(plugin as any).config = { role: 'admin' }

        const result = await plugin.pull()

        expect(result).toEqual([
            { table: 'users', rowsReplicated: 1 },
            { table: 'orders', rowsReplicated: 2 },
        ])
        expect(store.checkpoints.get('orders')?.last_value).toBe(
            JSON.stringify('2024-06-01')
        )
    })
})
