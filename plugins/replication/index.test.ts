import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ReplicationPlugin } from './index'
import { DataSource } from '../../src/types'

// Mock the external read path so the plugin can be exercised without a real
// external database connection.
const externalRows = vi.fn()
vi.mock('../../src/operation', () => ({
    executeQuery: (opts: any) => externalRows(opts),
}))

let plugin: ReplicationPlugin
let mockDataSource: DataSource
let rpcExecuteQuery: ReturnType<typeof vi.fn>

beforeEach(() => {
    vi.clearAllMocks()

    rpcExecuteQuery = vi.fn().mockResolvedValue([])
    mockDataSource = {
        rpc: { executeQuery: rpcExecuteQuery },
        source: 'internal',
        external: {
            dialect: 'postgresql',
            host: 'localhost',
            port: 5432,
            user: 'u',
            password: 'p',
            database: 'd',
        },
    } as unknown as DataSource

    plugin = new ReplicationPlugin({
        config: {
            tables: [
                {
                    sourceTable: 'users',
                    cursorColumn: 'id',
                },
            ],
        },
    })
    // Inject the data source / config the way the register() middleware would.
    plugin['dataSource'] = mockDataSource
    plugin['config'] = { role: 'admin' }
})

describe('ReplicationPlugin - initialization', () => {
    it('should be a StarbasePlugin with the expected name and prefix', () => {
        expect(plugin).toBeInstanceOf(ReplicationPlugin)
        expect(plugin.name).toBe('starbasedb:replication')
        expect(plugin.pathPrefix).toBe('/replication')
    })

    it('should create the checkpoint table on init', async () => {
        await plugin['init']()
        expect(rpcExecuteQuery).toHaveBeenCalledWith({
            sql: expect.stringContaining(
                'CREATE TABLE IF NOT EXISTS tmp_replication_checkpoints'
            ),
            params: [],
        })
    })
})

describe('ReplicationPlugin - replicate()', () => {
    it('throws when no external source is configured', async () => {
        plugin['dataSource'] = {
            ...mockDataSource,
            external: undefined,
        } as unknown as DataSource

        await expect(plugin.replicate()).rejects.toThrow(
            /No external data source/
        )
    })

    it('reads from the external source ordered by the cursor column and upserts rows internally', async () => {
        // No prior checkpoint -> first run with no WHERE filter.
        rpcExecuteQuery.mockResolvedValueOnce([]) // GET_CHECKPOINT
        externalRows.mockResolvedValueOnce([
            { id: 1, name: 'a' },
            { id: 2, name: 'b' },
        ])

        const results = await plugin.replicate()

        // External read happened with ORDER BY and no WHERE on the first run.
        expect(externalRows).toHaveBeenCalledTimes(1)
        const externalCall = externalRows.mock.calls[0][0]
        expect(externalCall.dataSource.source).toBe('external')
        expect(externalCall.sql).toContain('ORDER BY "id" ASC')
        expect(externalCall.sql).not.toContain('WHERE')

        // Two upserts into the internal table happened.
        const upserts = rpcExecuteQuery.mock.calls.filter((c) =>
            String(c[0].sql).startsWith('INSERT INTO "users"')
        )
        expect(upserts).toHaveLength(2)
        expect(upserts[0][0].sql).toContain('ON CONFLICT("id") DO UPDATE SET')

        // Result reports rows replicated and the advanced cursor value.
        expect(results).toEqual([
            { table: 'users', rowsReplicated: 2, lastValue: '2' },
        ])
    })

    it('uses the stored checkpoint to fetch only newer rows', async () => {
        rpcExecuteQuery.mockResolvedValueOnce([{ last_value: '5' }]) // GET_CHECKPOINT
        externalRows.mockResolvedValueOnce([{ id: 6, name: 'c' }])

        await plugin.replicate()

        const externalCall = externalRows.mock.calls[0][0]
        expect(externalCall.sql).toContain('WHERE "id" > ?')
        expect(externalCall.params).toEqual(['5'])
    })

    it('is fail-open: one failing table does not abort the others', async () => {
        plugin = new ReplicationPlugin({
            config: {
                tables: [
                    { sourceTable: 'good', cursorColumn: 'id' },
                    { sourceTable: 'bad', cursorColumn: 'id' },
                ],
            },
        })
        plugin['dataSource'] = mockDataSource
        plugin['config'] = { role: 'admin' }

        // good -> checkpoint empty, then rows; bad -> checkpoint empty, then throws
        rpcExecuteQuery.mockResolvedValueOnce([]) // good GET_CHECKPOINT
        externalRows.mockResolvedValueOnce([{ id: 1 }]) // good rows
        rpcExecuteQuery.mockResolvedValue([]) // subsequent internal writes
        externalRows.mockRejectedValueOnce(new Error('boom')) // bad rows

        const results = await plugin.replicate()

        expect(results).toHaveLength(2)
        expect(results[0]).toMatchObject({ table: 'good', rowsReplicated: 1 })
        expect(results[1]).toMatchObject({ table: 'bad', error: 'boom' })
    })
})
