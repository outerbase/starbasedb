import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
    DataSyncPlugin,
    DataSyncAdapter,
    PostgresSync,
    MySQLSync,
    ColumnInfo,
    TableSyncConfig,
} from './index'
import { StarbaseApp } from '../../src/handler'
import { DataSource } from '../../src/types'

// ─── Helpers ──────────────────────────────────────────────────────────────────

class MockAdapter extends DataSyncAdapter {
    public connectCalled = false
    public disconnectCalled = false
    public columns: ColumnInfo[] = [
        { name: 'id', nativeType: 'integer', sqliteType: 'INTEGER' },
        { name: 'name', nativeType: 'varchar', sqliteType: 'TEXT' },
        { name: 'created_at', nativeType: 'timestamp', sqliteType: 'TEXT' },
    ]
    public rows: Record<string, unknown>[] = [
        { id: 1, name: 'Alice', created_at: '2024-01-01T00:00:00Z' },
        { id: 2, name: 'Bob', created_at: '2024-01-02T00:00:00Z' },
    ]

    override async connect() {
        this.connectCalled = true
    }
    override async disconnect() {
        this.disconnectCalled = true
    }
    override mapType(nativeType: string): string {
        if (nativeType.includes('int')) return 'INTEGER'
        return 'TEXT'
    }
    override async getColumns(_tableName: string): Promise<ColumnInfo[]> {
        return this.columns
    }
    override async fetchRows(_opts: {
        tableName: string
        trackingColumn: string
        lastValue: string | null
    }): Promise<Record<string, unknown>[]> {
        return this.rows
    }
}

function makeMockDataSource(): DataSource {
    return {
        rpc: {
            executeQuery: vi.fn().mockResolvedValue([]),
            setAlarm: vi.fn().mockResolvedValue(undefined),
            getAlarm: vi.fn().mockResolvedValue(null),
            deleteAlarm: vi.fn().mockResolvedValue(undefined),
            getStatistics: vi.fn().mockResolvedValue({}),
        },
    } as unknown as DataSource
}

function makeMockApp(dataSource: DataSource): StarbaseApp {
    return {
        use: vi.fn(
            async (middleware: Function) =>
                await middleware({ get: vi.fn(() => dataSource) }, vi.fn())
        ),
        post: vi.fn(),
        get: vi.fn(),
    } as unknown as StarbaseApp
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('DataSyncPlugin - constructor', () => {
    it('should instantiate with required options', () => {
        const adapter = new MockAdapter()
        const plugin = new DataSyncPlugin({
            source: adapter,
            tables: [{ tableName: 'users', trackingColumn: 'id' }],
        })
        expect(plugin).toBeInstanceOf(DataSyncPlugin)
        expect(plugin.name).toBe('starbasedb:data-sync')
    })

    it('should use default syncIntervalMs when not specified', () => {
        const adapter = new MockAdapter()
        const plugin = new DataSyncPlugin({
            source: adapter,
            tables: [],
        })
        // Default is 5 minutes
        expect((plugin as any).syncIntervalMs).toBe(5 * 60 * 1000)
    })

    it('should use provided syncIntervalMs', () => {
        const adapter = new MockAdapter()
        const plugin = new DataSyncPlugin({
            source: adapter,
            tables: [],
            syncIntervalMs: 60_000,
        })
        expect((plugin as any).syncIntervalMs).toBe(60_000)
    })
})

describe('DataSyncPlugin - register()', () => {
    it('should create metadata table on register', async () => {
        const adapter = new MockAdapter()
        const dataSource = makeMockDataSource()
        const app = makeMockApp(dataSource)

        const plugin = new DataSyncPlugin({
            source: adapter,
            tables: [],
        })

        await plugin.register(app)

        // Middleware is invoked by the mock app.use(); wait a tick for async ops
        await new Promise((r) => setTimeout(r, 0))

        expect(dataSource.rpc.executeQuery).toHaveBeenCalledWith(
            expect.objectContaining({
                sql: expect.stringContaining('tmp_data_sync_metadata'),
            })
        )
    })

    it('should schedule a DO alarm via scheduleNextAlarm()', async () => {
        const adapter = new MockAdapter()
        const dataSource = makeMockDataSource()

        const plugin = new DataSyncPlugin({
            source: adapter,
            tables: [],
            syncIntervalMs: 10_000,
        })
        // Set dataSource directly and call the private method
        ;(plugin as any).dataSource = dataSource
        await (plugin as any).scheduleNextAlarm()

        expect(dataSource.rpc.setAlarm).toHaveBeenCalledTimes(1)
        const calledWith = (dataSource.rpc.setAlarm as any).mock.calls[0][0]
        expect(calledWith).toBeGreaterThan(Date.now())
    })
})

describe('DataSyncPlugin - beforeQuery() schema rewriting', () => {
    let plugin: DataSyncPlugin

    beforeEach(() => {
        plugin = new DataSyncPlugin({
            source: new MockAdapter(),
            tables: [],
        })
    })

    it('strips "public." prefix from table references', async () => {
        const result = await plugin.beforeQuery({
            sql: 'SELECT * FROM public.users',
        })
        expect(result.sql).toBe('SELECT * FROM users')
    })

    it('strips "public." from multiple references in one query', async () => {
        const result = await plugin.beforeQuery({
            sql: 'SELECT u.id, o.total FROM public.users u JOIN public.orders o ON u.id = o.user_id',
        })
        expect(result.sql).toBe(
            'SELECT u.id, o.total FROM users u JOIN orders o ON u.id = o.user_id'
        )
    })

    it('is case-insensitive for PUBLIC. prefix', async () => {
        const result = await plugin.beforeQuery({
            sql: 'SELECT * FROM PUBLIC.users',
        })
        expect(result.sql).toBe('SELECT * FROM users')
    })

    it('leaves non-public schema prefixes untouched', async () => {
        const result = await plugin.beforeQuery({
            sql: 'SELECT * FROM myschema.events',
        })
        expect(result.sql).toBe('SELECT * FROM myschema.events')
    })

    it('passes params through unchanged', async () => {
        const params = [42, 'test']
        const result = await plugin.beforeQuery({
            sql: 'SELECT * FROM public.users WHERE id = ?',
            params,
        })
        expect(result.params).toEqual(params)
    })
})

describe('DataSyncPlugin - afterQuery()', () => {
    it('returns the original result unchanged', async () => {
        const plugin = new DataSyncPlugin({
            source: new MockAdapter(),
            tables: [],
        })
        const result = [{ id: 1 }]
        const out = await plugin.afterQuery({
            sql: 'SELECT 1',
            result,
            isRaw: false,
        })
        expect(out).toBe(result)
    })
})

describe('DataSyncPlugin - runSync()', () => {
    it('connects to adapter, syncs tables, then disconnects', async () => {
        const adapter = new MockAdapter()
        const dataSource = makeMockDataSource()

        const plugin = new DataSyncPlugin({
            source: adapter,
            tables: [{ tableName: 'public.users', trackingColumn: 'id' }],
        })
        ;(plugin as any).dataSource = dataSource

        await plugin.runSync()

        expect(adapter.connectCalled).toBe(true)
        expect(adapter.disconnectCalled).toBe(true)
    })

    it('creates local table and upserts rows', async () => {
        const adapter = new MockAdapter()
        const dataSource = makeMockDataSource()

        const plugin = new DataSyncPlugin({
            source: adapter,
            tables: [{ tableName: 'public.users', trackingColumn: 'id' }],
        })
        ;(plugin as any).dataSource = dataSource

        await plugin.runSync()

        const calls = (dataSource.rpc.executeQuery as any).mock.calls.map(
            (c: any) => c[0].sql as string
        )

        // Should include CREATE TABLE for "users" (public. stripped)
        expect(
            calls.some((s: string) =>
                s.includes('CREATE TABLE IF NOT EXISTS "users"')
            )
        ).toBe(true)

        // Should include INSERT OR REPLACE
        expect(
            calls.some((s: string) =>
                s.includes('INSERT OR REPLACE INTO "users"')
            )
        ).toBe(true)

        // Should update metadata
        expect(
            calls.some((s: string) => s.includes('tmp_data_sync_metadata'))
        ).toBe(true)
    })

    it('schedules next alarm after sync', async () => {
        const adapter = new MockAdapter()
        const dataSource = makeMockDataSource()

        const plugin = new DataSyncPlugin({
            source: adapter,
            tables: [],
            syncIntervalMs: 30_000,
        })
        ;(plugin as any).dataSource = dataSource

        await plugin.runSync()

        expect(dataSource.rpc.setAlarm).toHaveBeenCalled()
    })
})

describe('DataSyncPlugin - stripSchemaPrefix (private)', () => {
    it('strips public. from table name', () => {
        const plugin = new DataSyncPlugin({
            source: new MockAdapter(),
            tables: [],
        })
        expect((plugin as any).stripSchemaPrefix('public.users')).toBe('users')
        expect((plugin as any).stripSchemaPrefix('PUBLIC.users')).toBe('users')
        expect((plugin as any).stripSchemaPrefix('users')).toBe('users')
        expect((plugin as any).stripSchemaPrefix('myschema.events')).toBe(
            'myschema.events'
        )
    })
})

describe('PostgresSync - mapType()', () => {
    it('maps integer types to INTEGER', () => {
        const adapter = new PostgresSync({
            host: 'localhost',
            user: 'u',
            password: 'p',
            database: 'db',
        })
        expect(adapter.mapType('integer')).toBe('INTEGER')
        expect(adapter.mapType('bigint')).toBe('INTEGER')
        expect(adapter.mapType('boolean')).toBe('INTEGER')
        expect(adapter.mapType('bool')).toBe('INTEGER')
    })

    it('maps floating-point types to REAL', () => {
        const adapter = new PostgresSync({
            host: 'localhost',
            user: 'u',
            password: 'p',
            database: 'db',
        })
        expect(adapter.mapType('float')).toBe('REAL')
        expect(adapter.mapType('numeric')).toBe('REAL')
        expect(adapter.mapType('decimal')).toBe('REAL')
    })

    it('maps bytea to BLOB', () => {
        const adapter = new PostgresSync({
            host: 'localhost',
            user: 'u',
            password: 'p',
            database: 'db',
        })
        expect(adapter.mapType('bytea')).toBe('BLOB')
    })

    it('maps text types to TEXT', () => {
        const adapter = new PostgresSync({
            host: 'localhost',
            user: 'u',
            password: 'p',
            database: 'db',
        })
        expect(adapter.mapType('varchar')).toBe('TEXT')
        expect(adapter.mapType('text')).toBe('TEXT')
        expect(adapter.mapType('timestamp')).toBe('TEXT')
    })
})

describe('MySQLSync - mapType()', () => {
    it('maps int types to INTEGER', () => {
        const adapter = new MySQLSync({
            host: 'localhost',
            user: 'u',
            password: 'p',
            database: 'db',
        })
        expect(adapter.mapType('int')).toBe('INTEGER')
        expect(adapter.mapType('bigint')).toBe('INTEGER')
        expect(adapter.mapType('tinyint')).toBe('INTEGER')
    })

    it('maps float types to REAL', () => {
        const adapter = new MySQLSync({
            host: 'localhost',
            user: 'u',
            password: 'p',
            database: 'db',
        })
        expect(adapter.mapType('float')).toBe('REAL')
        expect(adapter.mapType('decimal')).toBe('REAL')
    })

    it('maps blob types to BLOB', () => {
        const adapter = new MySQLSync({
            host: 'localhost',
            user: 'u',
            password: 'p',
            database: 'db',
        })
        expect(adapter.mapType('blob')).toBe('BLOB')
        expect(adapter.mapType('binary')).toBe('BLOB')
    })

    it('maps varchar to TEXT', () => {
        const adapter = new MySQLSync({
            host: 'localhost',
            user: 'u',
            password: 'p',
            database: 'db',
        })
        expect(adapter.mapType('varchar')).toBe('TEXT')
        expect(adapter.mapType('text')).toBe('TEXT')
    })
})

describe('DataSyncAdapter - configurable trackingColumn', () => {
    it('uses the user-specified tracking column, not a hardcoded one', async () => {
        const adapter = new MockAdapter()
        const fetchRowsSpy = vi.spyOn(adapter, 'fetchRows')

        const dataSource = makeMockDataSource()
        const plugin = new DataSyncPlugin({
            source: adapter,
            tables: [{ tableName: 'events', trackingColumn: 'event_time' }],
        })
        ;(plugin as any).dataSource = dataSource

        await plugin.runSync()

        expect(fetchRowsSpy).toHaveBeenCalledWith(
            expect.objectContaining({ trackingColumn: 'event_time' })
        )
    })
})
