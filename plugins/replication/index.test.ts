import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ReplicationPlugin, ReplicationTableConfig } from './index'
import { StarbaseDBConfiguration } from '../../src/handler'
import { DataSource, QueryResult } from '../../src/types'

function createMockDataSource() {
    const store = new Map<string, any[]>()
    const calls: { sql: string; params?: unknown[] }[] = []

    const rpc = {
        executeQuery: vi.fn(async ({ sql, params }: { sql: string; params?: unknown[] }) => {
            calls.push({ sql, params })
            const normalized = sql.trim().toUpperCase()

            if (normalized.startsWith('CREATE TABLE')) {
                return []
            }
            if (
                normalized.startsWith('SELECT') &&
                normalized.includes('WHERE TABLE_NAME = ?')
            ) {
                const tableName = params?.[0] as string
                return store.get(`state:${tableName}`) ?? []
            }
            if (normalized.startsWith('SELECT')) {
                const rows: any[] = []
                for (const [key, value] of store) {
                    if (key.startsWith('state:')) rows.push(...value)
                }
                return rows
            }
            if (normalized.startsWith('INSERT OR REPLACE INTO TMP_REPLICATION_STATE')) {
                store.set(`state:${params?.[0]}`, [
                    {
                        table_name: params?.[0],
                        schema_name: params?.[1],
                        watermark_column: params?.[2],
                        last_value: params?.[3],
                        last_sync_at: params?.[4],
                    },
                ])
                return []
            }
            if (normalized.startsWith('INSERT OR REPLACE INTO')) {
                const tableMatch = sql.match(/INTO "([^"]+)"/)
                const table = tableMatch?.[1] ?? 'unknown'
                const key = `rows:${table}`
                const existing = store.get(key) ?? []
                existing.push(params)
                store.set(key, existing)
                return []
            }
            return []
        }),
    }

    const dataSource = {
        rpc,
        source: 'internal',
    } as unknown as DataSource

    return { dataSource, store, calls }
}

const baseTables: ReplicationTableConfig[] = [
    { table: 'users', schema: 'public', watermarkColumn: 'id' },
]

let mockConfig: StarbaseDBConfiguration

beforeEach(() => {
    vi.clearAllMocks()
    mockConfig = { role: 'admin' } as StarbaseDBConfiguration
})

describe('ReplicationPlugin - syncNow', () => {
    it('pulls rows from the external source and writes them locally', async () => {
        const { dataSource, store } = createMockDataSource()
        const externalRows: QueryResult[] = [
            { id: 1, name: 'Alice' },
            { id: 2, name: 'Bob' },
        ]
        const queryExternal = vi.fn().mockResolvedValue(externalRows)

        const plugin = new ReplicationPlugin({
            tables: baseTables,
            queryExternal: queryExternal as any,
        })
        ;(plugin as any).dataSource = dataSource
        ;(plugin as any).config = mockConfig

        const results = await plugin.syncNow()

        expect(results).toHaveLength(1)
        expect(results[0]).toEqual({
            table: 'users',
            rowsReplicated: 2,
            lastValue: '2',
        })

        // External query should target the qualified table with a LIMIT.
        const externalCall = queryExternal.mock.calls[0][0]
        expect(externalCall.sql).toContain('FROM "public"."users"')
        expect(externalCall.sql).toContain('ORDER BY "id" ASC')
        expect(externalCall.sql).toContain('LIMIT ?')
        expect(externalCall.params).toEqual([500])

        // Rows should have been inserted locally.
        expect(store.get('rows:users')).toHaveLength(2)

        // State should have been persisted with the max watermark.
        const state = store.get('state:users')
        expect(state[0].last_value).toBe('2')
        expect(state[0].watermark_column).toBe('id')
    })

    it('appends only rows newer than the last watermark on subsequent syncs', async () => {
        const { dataSource, store } = createMockDataSource()
        store.set('state:users', [
            {
                table_name: 'users',
                schema_name: 'public',
                watermark_column: 'id',
                last_value: '2',
                last_sync_at: Date.now(),
            },
        ])

        const queryExternal = vi
            .fn()
            .mockResolvedValue([{ id: 3, name: 'Carol' }])

        const plugin = new ReplicationPlugin({
            tables: baseTables,
            queryExternal: queryExternal as any,
        })
        ;(plugin as any).dataSource = dataSource
        ;(plugin as any).config = mockConfig

        const results = await plugin.syncNow()

        const externalCall = queryExternal.mock.calls[0][0]
        expect(externalCall.sql).toContain('WHERE "id" > ?')
        expect(externalCall.params).toEqual(['2', 500])
        expect(results[0].lastValue).toBe('3')
    })

    it('rejects unsafe table identifiers', async () => {
        const { dataSource } = createMockDataSource()
        const queryExternal = vi.fn().mockResolvedValue([])

        const plugin = new ReplicationPlugin({
            tables: [{ table: 'users; DROP TABLE users' }],
            queryExternal: queryExternal as any,
        })
        ;(plugin as any).dataSource = dataSource
        ;(plugin as any).config = mockConfig

        const results = await plugin.syncNow()
        expect(results).toEqual([])
        expect(queryExternal).not.toHaveBeenCalled()
    })

    it('handles empty external result sets without inserting rows', async () => {
        const { dataSource, store } = createMockDataSource()
        const queryExternal = vi.fn().mockResolvedValue([])

        const plugin = new ReplicationPlugin({
            tables: baseTables,
            queryExternal: queryExternal as any,
        })
        ;(plugin as any).dataSource = dataSource
        ;(plugin as any).config = mockConfig

        const results = await plugin.syncNow()

        expect(results[0].rowsReplicated).toBe(0)
        expect(results[0].lastValue).toBeNull()
        expect(store.get('rows:users')).toBeUndefined()
    })

    it('throws when the plugin has not been initialized', async () => {
        const plugin = new ReplicationPlugin({
            tables: baseTables,
            queryExternal: vi.fn() as any,
        })

        await expect(plugin.syncNow()).rejects.toThrow(
            'ReplicationPlugin not properly initialized'
        )
    })
})

describe('ReplicationPlugin - getStatus', () => {
    it('returns the persisted replication state', async () => {
        const { dataSource, store } = createMockDataSource()
        store.set('state:users', [
            {
                table_name: 'users',
                schema_name: 'public',
                watermark_column: 'id',
                last_value: '7',
                last_sync_at: 123,
            },
        ])

        const plugin = new ReplicationPlugin({
            tables: baseTables,
            queryExternal: vi.fn() as any,
        })
        ;(plugin as any).dataSource = dataSource

        const status = await plugin.getStatus()
        expect(status).toHaveLength(1)
        expect(status[0].last_value).toBe('7')
    })
})
