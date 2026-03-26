import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DataSyncPlugin } from './index'
import { PostgresSyncAdapter, MySQLSyncAdapter, SyncAdapter } from './adapter'
import type { DataSyncConfig, SyncTableConfig, FetchResult } from './types'

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockDataSource() {
    return {
        rpc: {
            executeQuery: vi.fn().mockResolvedValue([]),
        },
        source: 'internal' as const,
        external: {
            dialect: 'postgresql' as const,
            host: 'localhost',
            port: 5432,
            user: 'test',
            password: 'test',
            database: 'testdb',
        },
    }
}

function createMockConfig() {
    return {
        role: 'admin' as const,
    }
}

// ---------------------------------------------------------------------------
// SyncAdapter base class
// ---------------------------------------------------------------------------

describe('SyncAdapter – mapToSQLiteType', () => {
    const adapter = new PostgresSyncAdapter()

    it('should map integer types to INTEGER', () => {
        expect(adapter.mapToSQLiteType('integer')).toBe('INTEGER')
        expect(adapter.mapToSQLiteType('bigint')).toBe('INTEGER')
        expect(adapter.mapToSQLiteType('smallint')).toBe('INTEGER')
        expect(adapter.mapToSQLiteType('serial')).toBe('INTEGER')
        expect(adapter.mapToSQLiteType('bigserial')).toBe('INTEGER')
    })

    it('should map boolean types to INTEGER', () => {
        expect(adapter.mapToSQLiteType('boolean')).toBe('INTEGER')
        expect(adapter.mapToSQLiteType('bool')).toBe('INTEGER')
    })

    it('should map float/decimal types to REAL', () => {
        expect(adapter.mapToSQLiteType('float')).toBe('REAL')
        expect(adapter.mapToSQLiteType('double precision')).toBe('REAL')
        expect(adapter.mapToSQLiteType('decimal')).toBe('REAL')
        expect(adapter.mapToSQLiteType('numeric')).toBe('REAL')
        expect(adapter.mapToSQLiteType('real')).toBe('REAL')
        expect(adapter.mapToSQLiteType('money')).toBe('REAL')
    })

    it('should map blob types to BLOB', () => {
        expect(adapter.mapToSQLiteType('blob')).toBe('BLOB')
        expect(adapter.mapToSQLiteType('bytea')).toBe('BLOB')
    })

    it('should map everything else to TEXT', () => {
        expect(adapter.mapToSQLiteType('varchar(255)')).toBe('TEXT')
        expect(adapter.mapToSQLiteType('text')).toBe('TEXT')
        expect(adapter.mapToSQLiteType('timestamp')).toBe('TEXT')
        expect(adapter.mapToSQLiteType('date')).toBe('TEXT')
        expect(adapter.mapToSQLiteType('json')).toBe('TEXT')
        expect(adapter.mapToSQLiteType('uuid')).toBe('TEXT')
        expect(adapter.mapToSQLiteType('timestamptz')).toBe('TEXT')
    })
})

describe('SyncAdapter – resolveTargetTable', () => {
    const adapter = new PostgresSyncAdapter()

    it('should use targetTable when provided', () => {
        const table: SyncTableConfig = {
            sourceTable: 'users',
            sourceSchema: 'public',
            targetTable: 'my_users',
        }
        expect(adapter.resolveTargetTable(table)).toBe('my_users')
    })

    it('should combine schema and table when no targetTable', () => {
        const table: SyncTableConfig = {
            sourceTable: 'users',
            sourceSchema: 'public',
        }
        expect(adapter.resolveTargetTable(table)).toBe('public_users')
    })

    it('should use sourceTable alone when no schema or targetTable', () => {
        const table: SyncTableConfig = {
            sourceTable: 'users',
        }
        expect(adapter.resolveTargetTable(table)).toBe('users')
    })
})

describe('SyncAdapter – qualifiedSourceTable', () => {
    it('should qualify with schema for PostgresSyncAdapter', () => {
        const adapter = new PostgresSyncAdapter()
        const table: SyncTableConfig = {
            sourceTable: 'users',
            sourceSchema: 'public',
        }
        expect(adapter.qualifiedSourceTable(table)).toBe('"public"."users"')
    })

    it('should use backticks for MySQLSyncAdapter', () => {
        const adapter = new MySQLSyncAdapter()
        const table: SyncTableConfig = {
            sourceTable: 'users',
            sourceSchema: 'mydb',
        }
        expect(adapter.qualifiedSourceTable(table)).toBe('`mydb`.`users`')
    })

    it('should omit schema when not provided', () => {
        const pg = new PostgresSyncAdapter()
        const my = new MySQLSyncAdapter()
        const table: SyncTableConfig = { sourceTable: 'orders' }
        expect(pg.qualifiedSourceTable(table)).toBe('"orders"')
        expect(my.qualifiedSourceTable(table)).toBe('`orders`')
    })
})

// ---------------------------------------------------------------------------
// PostgresSyncAdapter
// ---------------------------------------------------------------------------

describe('PostgresSyncAdapter', () => {
    const adapter = new PostgresSyncAdapter()

    it('should have dialect = "postgresql"', () => {
        expect(adapter.dialect).toBe('postgresql')
    })

    it('should build schema introspection query', async () => {
        const queryFn = vi.fn().mockResolvedValue([
            { column_name: 'id', data_type: 'integer' },
            { column_name: 'name', data_type: 'character varying' },
        ])

        const table: SyncTableConfig = {
            sourceTable: 'users',
            sourceSchema: 'public',
        }
        const columns = await adapter.fetchTableSchema(table, queryFn)

        expect(queryFn).toHaveBeenCalledOnce()
        expect(queryFn.mock.calls[0][0]).toContain('information_schema.columns')
        expect(queryFn.mock.calls[0][0]).toContain("table_name   = 'users'")
        expect(columns).toHaveLength(2)
        expect(columns[0]).toEqual({ name: 'id', sourceType: 'integer' })
    })

    it('should fetch rows without cursor (initial sync)', async () => {
        const queryFn = vi.fn().mockResolvedValue([
            { id: 1, name: 'Alice' },
            { id: 2, name: 'Bob' },
        ])

        const table: SyncTableConfig = {
            sourceTable: 'users',
            cursorColumn: 'id',
        }

        const result = await adapter.fetchRows(table, queryFn, null, 100)

        expect(queryFn).toHaveBeenCalledOnce()
        const sql = queryFn.mock.calls[0][0] as string
        expect(sql).toContain('ORDER BY "id" ASC')
        expect(sql).toContain('LIMIT 100')
        expect(sql).not.toContain('WHERE')
        expect(result.rows).toHaveLength(2)
    })

    it('should fetch rows with cursor (incremental sync)', async () => {
        const queryFn = vi.fn().mockResolvedValue([{ id: 3, name: 'Charlie' }])

        const table: SyncTableConfig = {
            sourceTable: 'users',
            cursorColumn: 'id',
        }

        const result = await adapter.fetchRows(table, queryFn, '2', 100)

        const sql = queryFn.mock.calls[0][0] as string
        expect(sql).toContain('WHERE "id" > \'2\'')
        expect(result.rows).toHaveLength(1)
    })

    it('should fetch all rows when no cursorColumn is set', async () => {
        const queryFn = vi.fn().mockResolvedValue([{ id: 1 }])

        const table: SyncTableConfig = {
            sourceTable: 'events',
        }

        await adapter.fetchRows(table, queryFn, null, 500)
        const sql = queryFn.mock.calls[0][0] as string
        expect(sql).not.toContain('ORDER BY')
        expect(sql).toContain('LIMIT 500')
    })
})

// ---------------------------------------------------------------------------
// MySQLSyncAdapter
// ---------------------------------------------------------------------------

describe('MySQLSyncAdapter', () => {
    const adapter = new MySQLSyncAdapter()

    it('should have dialect = "mysql"', () => {
        expect(adapter.dialect).toBe('mysql')
    })

    it('should build schema introspection query for MySQL', async () => {
        const queryFn = vi.fn().mockResolvedValue([
            { column_name: 'id', data_type: 'int' },
            { column_name: 'email', data_type: 'varchar' },
        ])

        const table: SyncTableConfig = {
            sourceTable: 'accounts',
            sourceSchema: 'myapp',
        }
        const columns = await adapter.fetchTableSchema(table, queryFn)

        expect(queryFn.mock.calls[0][0]).toContain("TABLE_SCHEMA = 'myapp'")
        expect(queryFn.mock.calls[0][0]).toContain("TABLE_NAME   = 'accounts'")
        expect(columns).toHaveLength(2)
    })

    it('should use backtick quoting in fetch queries', async () => {
        const queryFn = vi.fn().mockResolvedValue([])

        const table: SyncTableConfig = {
            sourceTable: 'orders',
            sourceSchema: 'shop',
            cursorColumn: 'created_at',
        }

        await adapter.fetchRows(table, queryFn, '2025-01-01', 50)

        const sql = queryFn.mock.calls[0][0] as string
        expect(sql).toContain('`shop`.`orders`')
        expect(sql).toContain('`created_at`')
    })
})

// ---------------------------------------------------------------------------
// DataSyncPlugin
// ---------------------------------------------------------------------------

describe('DataSyncPlugin', () => {
    let plugin: DataSyncPlugin
    let mockDataSource: ReturnType<typeof createMockDataSource>

    beforeEach(() => {
        vi.clearAllMocks()
        mockDataSource = createMockDataSource()

        plugin = new DataSyncPlugin({
            adapter: new PostgresSyncAdapter(),
            config: {
                tables: [
                    {
                        sourceTable: 'users',
                        sourceSchema: 'public',
                        cursorColumn: 'id',
                    },
                ],
                intervalMs: 30_000,
                batchSize: 500,
            },
        })
    })

    it('should have correct plugin name', () => {
        expect(plugin.name).toBe('starbasedb:data-sync')
    })

    it('should require auth by default', () => {
        expect(plugin.opts.requiresAuth).toBe(true)
    })

    it('should have path prefix /sync', () => {
        expect(plugin.pathPrefix).toBe('/sync')
    })
})

// ---------------------------------------------------------------------------
// DataSyncPlugin – runSyncCycle
// ---------------------------------------------------------------------------

describe('DataSyncPlugin – runSyncCycle', () => {
    let plugin: DataSyncPlugin
    let mockRpc: { executeQuery: ReturnType<typeof vi.fn> }
    let adapter: PostgresSyncAdapter

    beforeEach(() => {
        vi.clearAllMocks()

        adapter = new PostgresSyncAdapter()
        vi.spyOn(adapter, 'fetchTableSchema').mockResolvedValue([
            { name: 'id', sourceType: 'integer' },
            { name: 'name', sourceType: 'text' },
        ])
        vi.spyOn(adapter, 'fetchRows').mockResolvedValue({
            columns: [
                { name: 'id', sourceType: 'integer' },
                { name: 'name', sourceType: 'text' },
            ],
            rows: [
                { id: 1, name: 'Alice' },
                { id: 2, name: 'Bob' },
            ],
        })

        mockRpc = {
            executeQuery: vi.fn().mockResolvedValue([]),
        }

        plugin = new DataSyncPlugin({
            adapter,
            config: {
                tables: [
                    {
                        sourceTable: 'users',
                        sourceSchema: 'public',
                        cursorColumn: 'id',
                    },
                ],
                batchSize: 1000,
            },
        })

        // Inject the dataSource and config via the private fields
        ;(plugin as any).dataSource = {
            rpc: mockRpc,
            source: 'internal',
            external: {
                dialect: 'postgresql',
                host: 'localhost',
                port: 5432,
                user: 'test',
                password: 'test',
                database: 'testdb',
            },
        }
        ;(plugin as any).dbConfig = { role: 'admin' }
    })

    it('should run a sync cycle and report results', async () => {
        // Make the "table exists" check fail so ensureTargetTable creates it
        mockRpc.executeQuery
            .mockResolvedValueOnce([]) // CREATE_META
            .mockResolvedValueOnce([]) // CREATE_LOG
            .mockResolvedValueOnce([]) // GET_META – no prior checkpoint
            .mockRejectedValueOnce(new Error('no such table')) // table existence check
            // fetchTableSchema is handled by the adapter spy
            .mockResolvedValueOnce([]) // CREATE TABLE
            // fetchRows is handled by the adapter spy
            .mockResolvedValueOnce([]) // INSERT row 1
            .mockResolvedValueOnce([]) // INSERT row 2
            .mockResolvedValueOnce([]) // UPSERT_META
            .mockResolvedValueOnce([]) // INSERT_LOG

        // Need to call initTables first
        await (plugin as any).initTables()

        const results = await plugin.runSyncCycle()

        expect(results).toHaveLength(1)
        expect(results[0].table).toBe('public_users')
        expect(results[0].status).toBe('success')
        expect(results[0].rowsSynced).toBe(2)
    })

    it('should report error when external source is not configured', async () => {
        // Restore adapter spies so real methods run and hit the missing external
        vi.restoreAllMocks()
        ;(plugin as any).dataSource = {
            rpc: mockRpc,
            source: 'internal',
            // No external configured
        }

        await (plugin as any).initTables()

        const results = await plugin.runSyncCycle()

        expect(results).toHaveLength(1)
        expect(results[0].status).toBe('error')
        expect(results[0].error).toBeDefined()
    })

    it('should prevent concurrent sync runs', async () => {
        ;(plugin as any).syncInProgress = true
        const results = await plugin.runSyncCycle()
        expect(results).toHaveLength(0)
    })
})
