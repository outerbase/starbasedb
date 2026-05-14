import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ReplicatorPlugin, ReplicatedTable } from './index'
import { executeQuery } from '../../src/operation'
import { DataSource } from '../../src/types'

vi.mock('../../src/operation', () => ({
    executeQuery: vi.fn(),
}))

const mockedExecuteQuery = vi.mocked(executeQuery)

let plugin: ReplicatorPlugin
let internalQuery: ReturnType<typeof vi.fn>
let dataSource: DataSource

function makeTable(overrides: Partial<ReplicatedTable> = {}): ReplicatedTable {
    return {
        table_name: 'orders',
        source_schema: null,
        tracking_column: 'id',
        last_value: null,
        interval_seconds: 300,
        batch_size: 1000,
        is_active: 1,
        last_synced_at: null,
        ...overrides,
    }
}

beforeEach(() => {
    vi.clearAllMocks()
    internalQuery = vi.fn().mockResolvedValue([])
    dataSource = {
        rpc: { executeQuery: internalQuery },
        source: 'internal',
        external: { dialect: 'postgresql' },
    } as unknown as DataSource

    plugin = new ReplicatorPlugin()
    // Inject the data source the way the register() middleware would.
    ;(plugin as any).dataSource = dataSource
    ;(plugin as any).config = { role: 'admin' }
})

describe('ReplicatorPlugin - initialization', () => {
    it('registers with the expected name and route prefix', () => {
        expect(plugin.name).toBe('starbasedb:replicator')
        expect(plugin.pathPrefix).toBe('/replicator')
        expect(plugin.opts.requiresAuth).toBe(true)
    })
})

describe('ReplicatorPlugin - quoteIdentifier', () => {
    it('uses double quotes by default', () => {
        expect(plugin.quoteIdentifier('orders')).toBe('"orders"')
    })

    it('uses backticks for mysql', () => {
        expect(plugin.quoteIdentifier('orders', 'mysql')).toBe('`orders`')
    })

    it('escapes embedded quote characters', () => {
        expect(plugin.quoteIdentifier('we"ird')).toBe('"we""ird"')
        expect(plugin.quoteIdentifier('we`ird', 'mysql')).toBe('`we``ird`')
    })
})

describe('ReplicatorPlugin - quoteLiteral', () => {
    it('emits numbers bare', () => {
        expect(plugin.quoteLiteral(42)).toBe('42')
    })

    it('single-quotes strings and escapes quotes', () => {
        expect(plugin.quoteLiteral("O'Brien")).toBe("'O''Brien'")
    })

    it('renders null/undefined as NULL', () => {
        expect(plugin.quoteLiteral(null)).toBe('NULL')
        expect(plugin.quoteLiteral(undefined)).toBe('NULL')
    })
})

describe('ReplicatorPlugin - buildSelectQuery', () => {
    it('selects all rows when there is no watermark yet', () => {
        const sql = plugin.buildSelectQuery(makeTable(), 'postgresql')
        expect(sql).toBe('SELECT * FROM "orders" ORDER BY "id" ASC LIMIT 1000')
    })

    it('filters by the tracking column once a watermark exists', () => {
        const sql = plugin.buildSelectQuery(
            makeTable({ last_value: '100', batch_size: 50 }),
            'postgresql'
        )
        expect(sql).toBe(
            'SELECT * FROM "orders" WHERE "id" > \'100\' ORDER BY "id" ASC LIMIT 50'
        )
    })

    it('qualifies the table with its schema when provided', () => {
        const sql = plugin.buildSelectQuery(
            makeTable({ source_schema: 'public' }),
            'postgresql'
        )
        expect(sql).toBe(
            'SELECT * FROM "public"."orders" ORDER BY "id" ASC LIMIT 1000'
        )
    })
})

describe('ReplicatorPlugin - buildUpsertQuery', () => {
    it('builds a parameterized INSERT OR REPLACE statement', () => {
        const { sql, params } = plugin.buildUpsertQuery('orders', {
            id: 1,
            name: 'Alice',
        })
        expect(sql).toBe(
            'INSERT OR REPLACE INTO "orders" ("id", "name") VALUES (?, ?)'
        )
        expect(params).toEqual([1, 'Alice'])
    })
})

describe('ReplicatorPlugin - isDue', () => {
    it('is due when a table has never synced', () => {
        expect(plugin.isDue(makeTable())).toBe(true)
    })

    it('is not due when the interval has not elapsed', () => {
        const now = Date.now()
        const table = makeTable({
            interval_seconds: 300,
            last_synced_at: new Date(now - 60_000)
                .toISOString()
                .replace('T', ' ')
                .replace(/\.\d+Z$/, ''),
        })
        expect(plugin.isDue(table, now)).toBe(false)
    })

    it('is due once the interval has elapsed', () => {
        const now = Date.now()
        const table = makeTable({
            interval_seconds: 60,
            last_synced_at: new Date(now - 120_000)
                .toISOString()
                .replace('T', ' ')
                .replace(/\.\d+Z$/, ''),
        })
        expect(plugin.isDue(table, now)).toBe(true)
    })

    it('is never due when the table is inactive', () => {
        expect(plugin.isDue(makeTable({ is_active: 0 }))).toBe(false)
    })
})

describe('ReplicatorPlugin - registerTable', () => {
    it('upserts the table configuration with defaults', async () => {
        await plugin.registerTable({
            table: 'orders',
            trackingColumn: 'id',
        })

        expect(internalQuery).toHaveBeenCalledTimes(1)
        const call = internalQuery.mock.calls[0][0]
        expect(call.params).toEqual(['orders', null, 'id', 300, 1000, 1])
    })

    it('honors provided options', async () => {
        await plugin.registerTable({
            table: 'orders',
            schema: 'public',
            trackingColumn: 'created_at',
            intervalSeconds: 30,
            batchSize: 10,
            isActive: false,
        })

        const call = internalQuery.mock.calls[0][0]
        expect(call.params).toEqual([
            'orders',
            'public',
            'created_at',
            30,
            10,
            0,
        ])
    })
})

describe('ReplicatorPlugin - syncTable', () => {
    it('pulls external rows, upserts them and advances the watermark', async () => {
        mockedExecuteQuery.mockResolvedValue([
            { id: 1, name: 'Alice' },
            { id: 2, name: 'Bob' },
        ] as any)

        const result = await plugin.syncTable(makeTable())

        expect(result.rowsReplicated).toBe(2)
        expect(result.lastValue).toBe('2')

        // 2 upserts + 1 progress update on the internal database.
        expect(internalQuery).toHaveBeenCalledTimes(3)
        const upsert = internalQuery.mock.calls[0][0]
        expect(upsert.sql).toContain('INSERT OR REPLACE INTO "orders"')
        expect(upsert.params).toEqual([1, 'Alice'])

        const progress = internalQuery.mock.calls[2][0]
        expect(progress.params).toEqual(['2', 'orders'])
    })

    it('keeps the previous watermark when no new rows are returned', async () => {
        mockedExecuteQuery.mockResolvedValue([] as any)

        const result = await plugin.syncTable(makeTable({ last_value: '99' }))

        expect(result.rowsReplicated).toBe(0)
        expect(result.lastValue).toBe('99')
        // Only the progress update runs.
        expect(internalQuery).toHaveBeenCalledTimes(1)
        expect(internalQuery.mock.calls[0][0].params).toEqual(['99', 'orders'])
    })
})

describe('ReplicatorPlugin - sync', () => {
    it('captures per-table errors instead of failing the whole run', async () => {
        internalQuery.mockResolvedValueOnce([makeTable()])
        mockedExecuteQuery.mockRejectedValue(new Error('connection refused'))

        const results = await plugin.sync()

        expect(results).toHaveLength(1)
        expect(results[0].error).toBe('connection refused')
        expect(results[0].rowsReplicated).toBe(0)
    })

    it('skips inactive tables when syncing everything', async () => {
        internalQuery.mockResolvedValueOnce([
            makeTable({ table_name: 'orders', is_active: 0 }),
        ])

        const results = await plugin.sync()
        expect(results).toHaveLength(0)
        expect(mockedExecuteQuery).not.toHaveBeenCalled()
    })
})
