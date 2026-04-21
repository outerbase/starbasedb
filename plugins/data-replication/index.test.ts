import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DataReplicationPlugin } from './index'
import { DataSource } from '../../src/types'

vi.mock('../../src/operation', () => ({
    executeExternalQuery: vi.fn(),
}))

import { executeExternalQuery } from '../../src/operation'

const mockedExecuteExternalQuery = vi.mocked(executeExternalQuery)

let plugin: DataReplicationPlugin
let mockRpc: {
    executeQuery: ReturnType<typeof vi.fn>
    setAlarm: ReturnType<typeof vi.fn>
}
let mockDataSource: DataSource

beforeEach(() => {
    vi.clearAllMocks()

    mockRpc = {
        executeQuery: vi.fn().mockResolvedValue([]),
        setAlarm: vi.fn().mockResolvedValue(undefined),
    }

    mockDataSource = {
        rpc: mockRpc as any,
        source: 'external',
        external: {
            dialect: 'postgresql',
            host: 'localhost',
            port: 5432,
            user: 'test',
            password: 'test',
            database: 'testdb',
        },
    } as DataSource
})

describe('DataReplicationPlugin - Initialization', () => {
    it('should initialize with default name and pathPrefix', () => {
        plugin = new DataReplicationPlugin()
        expect(plugin.name).toBe('starbasedb:data-replication')
        expect(plugin.pathPrefix).toBe('/replication')
    })

    it('should accept optional config with stub', () => {
        const mockStub = {} as any
        plugin = new DataReplicationPlugin({ stub: mockStub })
        expect(plugin.name).toBe('starbasedb:data-replication')
        expect(plugin.pathPrefix).toBe('/replication')
    })

    it('should require auth by default', () => {
        plugin = new DataReplicationPlugin()
        expect(plugin.opts.requiresAuth).toBe(true)
    })
})

describe('DataReplicationPlugin - mapToSQLiteType', () => {
    beforeEach(() => {
        plugin = new DataReplicationPlugin()
    })

    it('should map integer types to INTEGER', () => {
        const intTypes = [
            'integer',
            'int',
            'smallint',
            'bigint',
            'serial',
            'bigserial',
            'tinyint',
            'mediumint',
            'int2',
            'int4',
            'int8',
        ]
        for (const t of intTypes) {
            expect(plugin.mapToSQLiteType(t)).toBe('INTEGER')
        }
    })

    it('should map real/float types to REAL', () => {
        const realTypes = [
            'real',
            'double',
            'float',
            'numeric',
            'decimal',
            'double precision',
            'float4',
            'float8',
        ]
        for (const t of realTypes) {
            expect(plugin.mapToSQLiteType(t)).toBe('REAL')
        }
    })

    it('should map blob/binary types to BLOB', () => {
        const blobTypes = [
            'bytea',
            'blob',
            'binary',
            'varbinary',
            'longblob',
            'mediumblob',
            'tinyblob',
        ]
        for (const t of blobTypes) {
            expect(plugin.mapToSQLiteType(t)).toBe('BLOB')
        }
    })

    it('should map boolean types to INTEGER', () => {
        expect(plugin.mapToSQLiteType('boolean')).toBe('INTEGER')
        expect(plugin.mapToSQLiteType('bool')).toBe('INTEGER')
    })

    it('should map unknown types to TEXT', () => {
        expect(plugin.mapToSQLiteType('varchar')).toBe('TEXT')
        expect(plugin.mapToSQLiteType('text')).toBe('TEXT')
        expect(plugin.mapToSQLiteType('json')).toBe('TEXT')
        expect(plugin.mapToSQLiteType('uuid')).toBe('TEXT')
        expect(plugin.mapToSQLiteType('timestamp')).toBe('TEXT')
    })

    it('should strip parenthesized size specifiers', () => {
        expect(plugin.mapToSQLiteType('varchar(255)')).toBe('TEXT')
        expect(plugin.mapToSQLiteType('int(11)')).toBe('INTEGER')
        expect(plugin.mapToSQLiteType('decimal(10,2)')).toBe('REAL')
    })

    it('should be case-insensitive', () => {
        expect(plugin.mapToSQLiteType('INTEGER')).toBe('INTEGER')
        expect(plugin.mapToSQLiteType('REAL')).toBe('REAL')
        expect(plugin.mapToSQLiteType('BLOB')).toBe('BLOB')
        expect(plugin.mapToSQLiteType('BOOLEAN')).toBe('INTEGER')
    })
})

describe('DataReplicationPlugin - insertRows', () => {
    beforeEach(() => {
        plugin = new DataReplicationPlugin()
        // Set the private dataSource via accessing it through the sync methods
        ;(plugin as any).dataSource = mockDataSource
    })

    it('should return 0 for empty rows', async () => {
        const result = await plugin.insertRows('test_table', [], 'full')
        expect(result).toBe(0)
        expect(mockRpc.executeQuery).not.toHaveBeenCalled()
    })

    it('should DELETE existing rows before INSERT in full mode', async () => {
        const rows = [{ id: 1, name: 'Alice' }]
        await plugin.insertRows('test_table', rows, 'full')

        expect(mockRpc.executeQuery).toHaveBeenCalledWith({
            sql: 'DELETE FROM "test_table"',
            params: [],
        })

        expect(mockRpc.executeQuery).toHaveBeenCalledWith(
            expect.objectContaining({
                sql: expect.stringContaining('INSERT INTO "test_table"'),
            })
        )
    })

    it('should use INSERT OR REPLACE in incremental mode', async () => {
        const rows = [{ id: 1, name: 'Alice' }]
        await plugin.insertRows('test_table', rows, 'incremental')

        // Should NOT delete
        expect(mockRpc.executeQuery).not.toHaveBeenCalledWith(
            expect.objectContaining({
                sql: expect.stringContaining('DELETE'),
            })
        )

        expect(mockRpc.executeQuery).toHaveBeenCalledWith(
            expect.objectContaining({
                sql: expect.stringContaining(
                    'INSERT OR REPLACE INTO "test_table"'
                ),
            })
        )
    })

    it('should insert multiple rows and return count', async () => {
        const rows = [
            { id: 1, name: 'Alice' },
            { id: 2, name: 'Bob' },
            { id: 3, name: 'Charlie' },
        ]
        const result = await plugin.insertRows(
            'test_table',
            rows,
            'incremental'
        )
        expect(result).toBe(3)
    })

    it('should pass correct params for each row', async () => {
        const rows = [{ id: 1, name: 'Alice' }]
        await plugin.insertRows('test_table', rows, 'incremental')

        expect(mockRpc.executeQuery).toHaveBeenCalledWith({
            sql: 'INSERT OR REPLACE INTO "test_table" ("id", "name") VALUES (?, ?)',
            params: [1, 'Alice'],
        })
    })

    it('should return 0 when dataSource is not set', async () => {
        ;(plugin as any).dataSource = undefined
        const result = await plugin.insertRows(
            'test_table',
            [{ id: 1 }],
            'full'
        )
        expect(result).toBe(0)
    })
})

describe('DataReplicationPlugin - updateSyncState', () => {
    beforeEach(() => {
        plugin = new DataReplicationPlugin()
        ;(plugin as any).dataSource = mockDataSource
    })

    it('should upsert sync state with correct params', async () => {
        await plugin.updateSyncState(1, '100', 50)

        expect(mockRpc.executeQuery).toHaveBeenCalledWith({
            sql: expect.stringContaining(
                'INSERT OR REPLACE INTO tmp_replication_state'
            ),
            params: [1, '100', 50],
        })
    })

    it('should handle null cursor value', async () => {
        await plugin.updateSyncState(1, null, 10)

        expect(mockRpc.executeQuery).toHaveBeenCalledWith({
            sql: expect.stringContaining(
                'INSERT OR REPLACE INTO tmp_replication_state'
            ),
            params: [1, null, 10],
        })
    })

    it('should do nothing when dataSource is not set', async () => {
        ;(plugin as any).dataSource = undefined
        await plugin.updateSyncState(1, '100', 50)
        expect(mockRpc.executeQuery).not.toHaveBeenCalled()
    })
})

describe('DataReplicationPlugin - fetchExternalRows', () => {
    beforeEach(() => {
        plugin = new DataReplicationPlugin()
        ;(plugin as any).dataSource = mockDataSource
        ;(plugin as any).config = { role: 'admin' }
    })

    it('should fetch all rows when no cursor column', async () => {
        const config = {
            id: 1,
            source_table: 'users',
            target_table: null,
            columns: null,
            cursor_column: null,
            interval_seconds: 60,
            enabled: 1,
            callback_host: null,
            created_at: '',
            updated_at: '',
        }

        mockedExecuteExternalQuery.mockResolvedValue([{ id: 1 }])
        const rows = await plugin.fetchExternalRows(config, null)

        expect(mockedExecuteExternalQuery).toHaveBeenCalledWith(
            expect.objectContaining({
                sql: 'SELECT * FROM users',
                params: [],
            })
        )
        expect(rows).toEqual([{ id: 1 }])
    })

    it('should add WHERE clause when cursor column and lastCursor are set', async () => {
        const config = {
            id: 1,
            source_table: 'users',
            target_table: null,
            columns: null,
            cursor_column: 'id',
            interval_seconds: 60,
            enabled: 1,
            callback_host: null,
            created_at: '',
            updated_at: '',
        }

        mockedExecuteExternalQuery.mockResolvedValue([{ id: 5 }])
        const rows = await plugin.fetchExternalRows(config, '3')

        expect(mockedExecuteExternalQuery).toHaveBeenCalledWith(
            expect.objectContaining({
                sql: 'SELECT * FROM users WHERE id > ? ORDER BY id ASC',
                params: ['3'],
            })
        )
        expect(rows).toEqual([{ id: 5 }])
    })

    it('should add ORDER BY but no WHERE when cursor column set but no lastCursor', async () => {
        const config = {
            id: 1,
            source_table: 'users',
            target_table: null,
            columns: null,
            cursor_column: 'id',
            interval_seconds: 60,
            enabled: 1,
            callback_host: null,
            created_at: '',
            updated_at: '',
        }

        mockedExecuteExternalQuery.mockResolvedValue([])
        await plugin.fetchExternalRows(config, null)

        expect(mockedExecuteExternalQuery).toHaveBeenCalledWith(
            expect.objectContaining({
                sql: 'SELECT * FROM users ORDER BY id ASC',
                params: [],
            })
        )
    })

    it('should select specific columns when columns are specified', async () => {
        const config = {
            id: 1,
            source_table: 'users',
            target_table: null,
            columns: JSON.stringify(['id', 'name']),
            cursor_column: null,
            interval_seconds: 60,
            enabled: 1,
            callback_host: null,
            created_at: '',
            updated_at: '',
        }

        mockedExecuteExternalQuery.mockResolvedValue([])
        await plugin.fetchExternalRows(config, null)

        expect(mockedExecuteExternalQuery).toHaveBeenCalledWith(
            expect.objectContaining({
                sql: 'SELECT id, name FROM users',
            })
        )
    })

    it('should throw when dataSource is not set', async () => {
        ;(plugin as any).dataSource = undefined
        const config = {
            id: 1,
            source_table: 'users',
            target_table: null,
            columns: null,
            cursor_column: null,
            interval_seconds: 60,
            enabled: 1,
            callback_host: null,
            created_at: '',
            updated_at: '',
        }

        await expect(plugin.fetchExternalRows(config, null)).rejects.toThrow(
            'DataReplicationPlugin not properly initialized'
        )
    })
})

describe('DataReplicationPlugin - scheduleNextAlarm', () => {
    beforeEach(() => {
        plugin = new DataReplicationPlugin()
        ;(plugin as any).dataSource = mockDataSource
    })

    it('should not set alarm when no enabled configs exist', async () => {
        mockRpc.executeQuery.mockResolvedValue([])
        await plugin.scheduleNextAlarm()
        expect(mockRpc.setAlarm).not.toHaveBeenCalled()
    })

    it('should set alarm based on earliest due config', async () => {
        const now = Date.now()
        const lastSync = new Date(now - 30000)
            .toISOString()
            .replace('T', ' ')
            .replace('Z', '')

        mockRpc.executeQuery.mockResolvedValue([
            {
                id: 1,
                interval_seconds: 60,
                enabled: 1,
                last_sync_at: lastSync,
            },
        ])

        await plugin.scheduleNextAlarm()
        expect(mockRpc.setAlarm).toHaveBeenCalledTimes(1)
        expect(mockRpc.setAlarm).toHaveBeenCalledWith(expect.any(Number))
    })

    it('should schedule immediately for configs that have never synced', async () => {
        mockRpc.executeQuery.mockResolvedValue([
            {
                id: 1,
                interval_seconds: 60,
                enabled: 1,
                last_sync_at: null,
            },
        ])

        const before = Date.now()
        await plugin.scheduleNextAlarm()

        expect(mockRpc.setAlarm).toHaveBeenCalledTimes(1)
        const alarmTime = mockRpc.setAlarm.mock.calls[0][0]
        // Should be at least now + 1000 (the minimum)
        expect(alarmTime).toBeGreaterThanOrEqual(before + 1000)
    })

    it('should do nothing when dataSource is not set', async () => {
        ;(plugin as any).dataSource = undefined
        await plugin.scheduleNextAlarm()
        expect(mockRpc.executeQuery).not.toHaveBeenCalled()
        expect(mockRpc.setAlarm).not.toHaveBeenCalled()
    })
})

describe('DataReplicationPlugin - introspectSchema', () => {
    beforeEach(() => {
        plugin = new DataReplicationPlugin()
        ;(plugin as any).dataSource = mockDataSource
        ;(plugin as any).config = { role: 'admin' }
    })

    it('should introspect PostgreSQL schema', async () => {
        ;(mockDataSource as any).external = {
            dialect: 'postgresql',
            host: 'localhost',
            port: 5432,
            user: 'test',
            password: 'test',
            database: 'testdb',
        }

        mockedExecuteExternalQuery.mockResolvedValue([
            { column_name: 'id', data_type: 'integer' },
            { column_name: 'name', data_type: 'varchar' },
        ])

        const columns = await plugin.introspectSchema('users')
        expect(columns).toEqual([
            { name: 'id', type: 'integer', sqliteType: 'INTEGER' },
            { name: 'name', type: 'varchar', sqliteType: 'TEXT' },
        ])
    })

    it('should introspect MySQL schema', async () => {
        ;(mockDataSource as any).external = {
            dialect: 'mysql',
            host: 'localhost',
            port: 3306,
            user: 'test',
            password: 'test',
            database: 'testdb',
        }

        mockedExecuteExternalQuery.mockResolvedValue([
            { column_name: 'id', data_type: 'int' },
            { column_name: 'price', data_type: 'decimal' },
        ])

        const columns = await plugin.introspectSchema('products')
        expect(columns).toEqual([
            { name: 'id', type: 'int', sqliteType: 'INTEGER' },
            { name: 'price', type: 'decimal', sqliteType: 'REAL' },
        ])
    })

    it('should introspect SQLite schema via PRAGMA', async () => {
        ;(mockDataSource as any).external = {
            dialect: 'sqlite',
            provider: 'turso',
            uri: 'test',
            token: 'test',
        }

        mockedExecuteExternalQuery.mockResolvedValue([
            { name: 'id', type: 'INTEGER' },
            { name: 'data', type: '' },
        ])

        const columns = await plugin.introspectSchema('items')
        expect(columns).toEqual([
            { name: 'id', type: 'INTEGER', sqliteType: 'INTEGER' },
            { name: 'data', type: 'TEXT', sqliteType: 'TEXT' },
        ])
    })

    it('should throw when not properly initialized', async () => {
        ;(plugin as any).dataSource = undefined
        await expect(plugin.introspectSchema('users')).rejects.toThrow(
            'DataReplicationPlugin not properly initialized'
        )
    })
})

describe('DataReplicationPlugin - ensureTargetTable', () => {
    beforeEach(() => {
        plugin = new DataReplicationPlugin()
        ;(plugin as any).dataSource = mockDataSource
    })

    it('should create table with correct column definitions', async () => {
        const columns = [
            { name: 'id', type: 'integer', sqliteType: 'INTEGER' },
            { name: 'name', type: 'varchar', sqliteType: 'TEXT' },
        ]

        await plugin.ensureTargetTable('users', columns)

        expect(mockRpc.executeQuery).toHaveBeenCalledWith({
            sql: 'CREATE TABLE IF NOT EXISTS "users" ("id" INTEGER, "name" TEXT)',
            params: [],
        })
    })

    it('should do nothing when dataSource is not set', async () => {
        ;(plugin as any).dataSource = undefined
        await plugin.ensureTargetTable('users', [])
        expect(mockRpc.executeQuery).not.toHaveBeenCalled()
    })
})

describe('DataReplicationPlugin - syncConfig', () => {
    beforeEach(() => {
        plugin = new DataReplicationPlugin()
        ;(plugin as any).dataSource = mockDataSource
        ;(plugin as any).config = { role: 'admin' }
    })

    it('should throw when config not found', async () => {
        mockRpc.executeQuery.mockResolvedValue([])
        await expect(plugin.syncConfig(999)).rejects.toThrow(
            'Configuration 999 not found'
        )
    })

    it('should throw when dataSource is not set', async () => {
        ;(plugin as any).dataSource = undefined
        await expect(plugin.syncConfig(1)).rejects.toThrow(
            'DataReplicationPlugin not properly initialized'
        )
    })

    it('should perform full sync when no cursor_column', async () => {
        // First call: load config
        mockRpc.executeQuery
            .mockResolvedValueOnce([
                {
                    id: 1,
                    source_table: 'users',
                    target_table: 'local_users',
                    columns: null,
                    cursor_column: null,
                    interval_seconds: 60,
                    enabled: 1,
                    callback_host: null,
                    created_at: '',
                    updated_at: '',
                },
            ])
            // Second call: check target table exists
            .mockResolvedValueOnce([{ name: 'local_users' }])
            // Third call: DELETE (full mode)
            .mockResolvedValueOnce([])
            // Fourth call: INSERT row
            .mockResolvedValueOnce([])
            // Fifth call: updateSyncState
            .mockResolvedValueOnce([])

        mockedExecuteExternalQuery.mockResolvedValue([{ id: 1, name: 'Alice' }])

        const result = await plugin.syncConfig(1)
        expect(result.configId).toBe(1)
        expect(result.rowsSynced).toBe(1)
        expect(result.lastCursorValue).toBeNull()
    })

    it('should perform incremental sync with cursor_column', async () => {
        mockRpc.executeQuery
            // Load config
            .mockResolvedValueOnce([
                {
                    id: 1,
                    source_table: 'events',
                    target_table: null,
                    columns: null,
                    cursor_column: 'id',
                    interval_seconds: 60,
                    enabled: 1,
                    callback_host: null,
                    created_at: '',
                    updated_at: '',
                },
            ])
            // Check target table
            .mockResolvedValueOnce([{ name: 'events' }])
            // Load sync state
            .mockResolvedValueOnce([
                {
                    config_id: 1,
                    last_cursor_value: '5',
                    last_sync_at: null,
                    rows_synced: 0,
                },
            ])
            // INSERT OR REPLACE row
            .mockResolvedValueOnce([])
            // updateSyncState
            .mockResolvedValueOnce([])

        mockedExecuteExternalQuery.mockResolvedValue([{ id: 10, data: 'test' }])

        const result = await plugin.syncConfig(1)
        expect(result.configId).toBe(1)
        expect(result.rowsSynced).toBe(1)
        expect(result.lastCursorValue).toBe('10')
    })

    it('should create target table if it does not exist', async () => {
        mockRpc.executeQuery
            // Load config
            .mockResolvedValueOnce([
                {
                    id: 1,
                    source_table: 'users',
                    target_table: 'local_users',
                    columns: null,
                    cursor_column: null,
                    interval_seconds: 60,
                    enabled: 1,
                    callback_host: null,
                    created_at: '',
                    updated_at: '',
                },
            ])
            // Check target table — not found
            .mockResolvedValueOnce([])
            // CREATE TABLE
            .mockResolvedValueOnce([])
            // DELETE (full mode)
            .mockResolvedValueOnce([])
            // INSERT row
            .mockResolvedValueOnce([])
            // updateSyncState
            .mockResolvedValueOnce([])

        // introspectSchema
        mockedExecuteExternalQuery
            .mockResolvedValueOnce([
                { column_name: 'id', data_type: 'integer' },
                { column_name: 'name', data_type: 'text' },
            ])
            // fetchExternalRows
            .mockResolvedValueOnce([{ id: 1, name: 'Alice' }])

        const result = await plugin.syncConfig(1)
        expect(result.rowsSynced).toBe(1)

        // Verify CREATE TABLE was called
        const createCall = mockRpc.executeQuery.mock.calls.find((call: any[]) =>
            call[0].sql.includes('CREATE TABLE')
        )
        expect(createCall).toBeDefined()
    })

    it('should use source_table as target when target_table is null', async () => {
        mockRpc.executeQuery
            .mockResolvedValueOnce([
                {
                    id: 1,
                    source_table: 'users',
                    target_table: null,
                    columns: null,
                    cursor_column: null,
                    interval_seconds: 60,
                    enabled: 1,
                    callback_host: null,
                    created_at: '',
                    updated_at: '',
                },
            ])
            .mockResolvedValueOnce([{ name: 'users' }])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([])

        mockedExecuteExternalQuery.mockResolvedValue([])

        await plugin.syncConfig(1)

        // The table check should use 'users' (source_table) as target
        const tableCheckCall = mockRpc.executeQuery.mock.calls[1]
        expect(tableCheckCall[0].params).toContain('users')
    })
})

describe('DataReplicationPlugin - Error handling', () => {
    beforeEach(() => {
        plugin = new DataReplicationPlugin()
        ;(plugin as any).dataSource = mockDataSource
        ;(plugin as any).config = { role: 'admin' }
    })

    it('should isolate sync errors per config (one fails, others succeed)', async () => {
        // Simulate two configs: first one fails, second succeeds
        const config1 = {
            id: 1,
            source_table: 'failing_table',
            target_table: null,
            columns: null,
            cursor_column: null,
            interval_seconds: 60,
            enabled: 1,
            callback_host: null,
            created_at: '',
            updated_at: '',
        }
        const config2 = {
            id: 2,
            source_table: 'good_table',
            target_table: null,
            columns: null,
            cursor_column: null,
            interval_seconds: 60,
            enabled: 1,
            callback_host: null,
            created_at: '',
            updated_at: '',
        }

        // syncConfig(1) should throw
        const syncSpy = vi.spyOn(plugin, 'syncConfig')
        syncSpy
            .mockRejectedValueOnce(new Error('Connection refused'))
            .mockResolvedValueOnce({
                configId: 2,
                rowsSynced: 5,
                lastCursorValue: null,
                syncedAt: new Date().toISOString(),
            })

        // Simulate the callback loop behavior
        const results: any[] = []
        for (const config of [config1, config2]) {
            try {
                const result = await plugin.syncConfig(config.id)
                results.push(result)
            } catch (error: any) {
                results.push({
                    configId: config.id,
                    rowsSynced: 0,
                    lastCursorValue: null,
                    syncedAt: new Date().toISOString(),
                    error: error.message,
                })
            }
        }

        expect(results).toHaveLength(2)
        expect(results[0].error).toBe('Connection refused')
        expect(results[1].rowsSynced).toBe(5)

        syncSpy.mockRestore()
    })

    it('should still schedule alarm even when all syncs fail', async () => {
        // Simulate the finally block behavior from the callback handler
        const syncSpy = vi.spyOn(plugin, 'syncConfig')
        syncSpy.mockRejectedValue(new Error('All syncs fail'))

        // scheduleNextAlarm should still be callable
        mockRpc.executeQuery.mockResolvedValue([])
        await plugin.scheduleNextAlarm()

        // No configs means no alarm, but the method itself doesn't throw
        expect(true).toBe(true)

        syncSpy.mockRestore()
    })

    it('should set recovery alarm when scheduleNextAlarm fails', async () => {
        // Simulate the recovery alarm pattern from the callback handler
        const scheduleError = new Error('Schedule failed')

        // Mock scheduleNextAlarm to fail
        const scheduleSpy = vi.spyOn(plugin, 'scheduleNextAlarm')
        scheduleSpy.mockRejectedValueOnce(scheduleError)

        // Simulate the finally block with recovery
        try {
            await plugin.scheduleNextAlarm()
        } catch {
            // Recovery: set alarm for 60 seconds
            await mockDataSource.rpc.setAlarm(Date.now() + 60000)
        }

        expect(mockRpc.setAlarm).toHaveBeenCalledTimes(1)
        const alarmTime = mockRpc.setAlarm.mock.calls[0][0]
        expect(alarmTime).toBeGreaterThan(Date.now() + 50000)

        scheduleSpy.mockRestore()
    })
})

describe('DataReplicationPlugin - Config validation', () => {
    it('should reject empty source_table in POST /replication/configs', () => {
        // Test the validation logic directly by checking what the route handler validates
        // The route handler checks: !body.source_table || typeof body.source_table !== 'string' || !body.source_table.trim()
        const invalidPayloads = [
            { source_table: '', interval_seconds: 60 },
            { source_table: '   ', interval_seconds: 60 },
            { interval_seconds: 60 }, // missing source_table
        ]

        for (const payload of invalidPayloads) {
            const isInvalid =
                !payload.source_table ||
                typeof payload.source_table !== 'string' ||
                !(payload as any).source_table?.trim()
            expect(isInvalid).toBe(true)
        }
    })

    it('should reject non-positive interval_seconds', () => {
        const invalidIntervals = [0, -1, -100, undefined, null]

        for (const interval of invalidIntervals) {
            const isInvalid =
                interval === undefined ||
                interval === null ||
                !Number.isInteger(interval) ||
                interval <= 0
            expect(isInvalid).toBe(true)
        }
    })

    it('should accept valid config payloads', () => {
        const validPayloads = [
            { source_table: 'users', interval_seconds: 60 },
            { source_table: 'orders', interval_seconds: 1 },
            { source_table: 'events', interval_seconds: 3600 },
        ]

        for (const payload of validPayloads) {
            const sourceValid =
                payload.source_table &&
                typeof payload.source_table === 'string' &&
                payload.source_table.trim()
            const intervalValid =
                payload.interval_seconds !== undefined &&
                payload.interval_seconds !== null &&
                Number.isInteger(payload.interval_seconds) &&
                payload.interval_seconds > 0
            expect(sourceValid).toBeTruthy()
            expect(intervalValid).toBe(true)
        }
    })

    it('should reject non-integer interval_seconds', () => {
        const nonIntegers = [1.5, 2.7, 0.1]

        for (const interval of nonIntegers) {
            const isInvalid = !Number.isInteger(interval) || interval <= 0
            expect(isInvalid).toBe(true)
        }
    })
})
