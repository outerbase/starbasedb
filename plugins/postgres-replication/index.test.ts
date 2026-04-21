import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PostgresReplicationPlugin, ReplicationConfig } from './index'
import { DataSource, QueryResult } from '../../src/types'

let plugin: PostgresReplicationPlugin
let mockRpc: {
    executeQuery: ReturnType<typeof vi.fn>
}
let mockDataSource: DataSource

beforeEach(() => {
    vi.clearAllMocks()

    mockRpc = {
        executeQuery: vi.fn().mockResolvedValue([]),
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
    } as any

    plugin = new PostgresReplicationPlugin()
})

describe('PostgresReplicationPlugin - Initialization', () => {
    it('should initialize with correct default values', () => {
        expect(plugin.pathPrefix).toBe('/replication')
        expect(plugin.name).toBe('starbasedb:postgres-replication')
    })

    it('should accept a custom path prefix', () => {
        const customPlugin = new PostgresReplicationPlugin({
            pathPrefix: '/pg-sync',
        })
        expect(customPlugin.pathPrefix).toBe('/pg-sync')
    })
})

describe('PostgresReplicationPlugin - Config management', () => {
    it('should add a replication config', async () => {
        // Simulate init + addReplicationConfig
        ;(plugin as any).dataSource = mockDataSource

        await plugin.addReplicationConfig({
            sourceTable: 'users',
            targetTable: 'users_local',
            sourceSchema: 'public',
            primaryKey: 'id',
            syncIntervalMs: 30000,
        })

        // Should have called executeQuery with INSERT_CONFIG
        const calls = mockRpc.executeQuery.mock.calls
        const insertCall = calls.find(
            (c: any[]) => typeof c[0]?.sql === 'string' && c[0].sql.includes('INSERT INTO tmp_pg_replication_config')
        )
        expect(insertCall).toBeDefined()
        expect(insertCall![0].params).toEqual([
            'users',
            'users_local',
            'public',
            'id',
            30000,
        ])
    })

    it('should use default values when optional params are omitted', async () => {
        ;(plugin as any).dataSource = mockDataSource

        await plugin.addReplicationConfig({
            sourceTable: 'orders',
            targetTable: 'orders_local',
        })

        const calls = mockRpc.executeQuery.mock.calls
        const insertCall = calls.find(
            (c: any[]) => typeof c[0]?.sql === 'string' && c[0].sql.includes('INSERT INTO tmp_pg_replication_config')
        )
        expect(insertCall).toBeDefined()
        expect(insertCall![0].params).toEqual([
            'orders',
            'orders_local',
            'public',
            'id',
            60000,
        ])
    })

    it('should return empty array when dataSource is not set', async () => {
        const configs = await plugin.getAllConfigs()
        expect(configs).toEqual([])
    })

    it('should return null when config not found', async () => {
        ;(plugin as any).dataSource = mockDataSource
        mockRpc.executeQuery.mockResolvedValueOnce([])
        const config = await plugin.getConfigById(999)
        expect(config).toBeNull()
    })

    it('should return config when found', async () => {
        ;(plugin as any).dataSource = mockDataSource
        const mockConfig: ReplicationConfig = {
            id: 1,
            source_table: 'users',
            target_table: 'users_local',
            source_schema: 'public',
            primary_key: 'id',
            sync_interval_ms: 60000,
            last_synced_at: null,
            last_synced_cursor: null,
            is_active: 1,
        }
        mockRpc.executeQuery.mockResolvedValueOnce([mockConfig])
        const config = await plugin.getConfigById(1)
        expect(config).toEqual(mockConfig)
    })

    it('should delete a config', async () => {
        ;(plugin as any).dataSource = mockDataSource

        await plugin.deleteConfig(1)

        const calls = mockRpc.executeQuery.mock.calls
        const deleteCall = calls.find(
            (c: any[]) =>
                typeof c[0]?.sql === 'string' &&
                c[0].sql.includes('DELETE FROM tmp_pg_replication_config')
        )
        expect(deleteCall).toBeDefined()
        expect(deleteCall![0].params).toEqual([1])
    })

    it('should update active status', async () => {
        ;(plugin as any).dataSource = mockDataSource

        await plugin.setConfigActive(1, 0)

        const calls = mockRpc.executeQuery.mock.calls
        const updateCall = calls.find(
            (c: any[]) =>
                typeof c[0]?.sql === 'string' &&
                c[0].sql.includes('UPDATE tmp_pg_replication_config SET is_active')
        )
        expect(updateCall).toBeDefined()
        expect(updateCall![0].params).toEqual([0, 1])
    })
})

describe('PostgresReplicationPlugin - Sync operations', () => {
    const mockConfig: ReplicationConfig = {
        id: 1,
        source_table: 'users',
        target_table: 'users_local',
        source_schema: 'public',
        primary_key: 'id',
        sync_interval_ms: 60000,
        last_synced_at: null,
        last_synced_cursor: null,
        is_active: 1,
    }

    it('should throw when no external source is configured', async () => {
        ;(plugin as any).dataSource = {
            ...mockDataSource,
            source: 'internal',
            external: undefined,
        }

        await expect(plugin.syncTable(1, 'full')).rejects.toThrow(
            'No external PostgreSQL data source configured'
        )
    })

    it('should throw when external dialect is not postgresql', async () => {
        ;(plugin as any).dataSource = {
            ...mockDataSource,
            external: { dialect: 'mysql', host: 'localhost', port: 3306, user: 'test', password: 'test', database: 'testdb' },
        }

        await expect(plugin.syncTable(1, 'full')).rejects.toThrow(
            'External data source must use the "postgresql" dialect'
        )
    })

    it('should throw when config is not found', async () => {
        ;(plugin as any).dataSource = mockDataSource
        mockRpc.executeQuery.mockResolvedValueOnce([]) // INSERT_SYNC_LOG
        mockRpc.executeQuery.mockResolvedValueOnce([]) // GET_CONFIG_BY_ID returns empty

        await expect(plugin.syncTable(999, 'full')).rejects.toThrow(
            'Replication config with id 999 not found'
        )
    })

    it('should perform full sync and return correct row count', async () => {
        ;(plugin as any).dataSource = mockDataSource

        const mockRows = [
            { id: 1, name: 'Alice', email: 'alice@example.com' },
            { id: 2, name: 'Bob', email: 'bob@example.com' },
        ]

        // Sequence of executeQuery calls:
        // 1. INSERT_SYNC_LOG
        mockRpc.executeQuery.mockResolvedValueOnce({ lastRowId: 1 })
        // 2. GET_CONFIG_BY_ID
        mockRpc.executeQuery.mockResolvedValueOnce([mockConfig])
        // 3. SELECT * FROM external source
        mockRpc.executeQuery.mockResolvedValueOnce(mockRows)
        // 4-5. Two INSERT OR REPLACE calls (one per row)
        mockRpc.executeQuery.mockResolvedValueOnce([])
        mockRpc.executeQuery.mockResolvedValueOnce([])
        // 6. UPDATE_SYNC_CURSOR
        mockRpc.executeQuery.mockResolvedValueOnce([])
        // 7. UPDATE_SYNC_LOG_SUCCESS
        mockRpc.executeQuery.mockResolvedValueOnce([])

        const result = await plugin.syncTable(1, 'full')

        expect(result.status).toBe('success')
        expect(result.rowsSynced).toBe(2)
        expect(result.syncType).toBe('full')
    })

    it('should handle empty source table gracefully', async () => {
        ;(plugin as any).dataSource = mockDataSource

        mockRpc.executeQuery.mockResolvedValueOnce({ lastRowId: 1 }) // log
        mockRpc.executeQuery.mockResolvedValueOnce([mockConfig]) // config
        mockRpc.executeQuery.mockResolvedValueOnce([]) // empty source
        mockRpc.executeQuery.mockResolvedValueOnce([]) // update cursor
        mockRpc.executeQuery.mockResolvedValueOnce([]) // update log

        const result = await plugin.syncTable(1, 'full')

        expect(result.status).toBe('success')
        expect(result.rowsSynced).toBe(0)
    })

    it('should fall back to full sync when no cursor exists for incremental', async () => {
        ;(plugin as any).dataSource = mockDataSource

        const configNoCursor = { ...mockConfig, last_synced_cursor: null }
        const mockRows = [{ id: 1, name: 'Alice' }]

        mockRpc.executeQuery.mockResolvedValueOnce({ lastRowId: 1 }) // log
        mockRpc.executeQuery.mockResolvedValueOnce([configNoCursor]) // config
        mockRpc.executeQuery.mockResolvedValueOnce(mockRows) // SELECT *
        mockRpc.executeQuery.mockResolvedValueOnce([]) // upsert
        mockRpc.executeQuery.mockResolvedValueOnce([]) // cursor
        mockRpc.executeQuery.mockResolvedValueOnce([]) // log success

        const result = await plugin.syncTable(1, 'incremental')

        expect(result.status).toBe('success')
        expect(result.rowsSynced).toBe(1)
    })

    it('should return error status on sync failure', async () => {
        ;(plugin as any).dataSource = mockDataSource

        mockRpc.executeQuery.mockResolvedValueOnce({ lastRowId: 1 }) // log
        mockRpc.executeQuery.mockResolvedValueOnce([mockConfig]) // config
        mockRpc.executeQuery.mockRejectedValueOnce(
            new Error('Connection refused')
        ) // source query fails
        mockRpc.executeQuery.mockResolvedValueOnce([]) // update log error

        const result = await plugin.syncTable(1, 'full')

        expect(result.status).toBe('error')
        expect(result.error).toBe('Connection refused')
        expect(result.rowsSynced).toBe(0)
    })
})

describe('PostgresReplicationPlugin - Event callbacks', () => {
    it('should register event callbacks', () => {
        const mockCallback = vi.fn()
        plugin.onEvent(mockCallback)
        expect((plugin as any).eventCallbacks).toHaveLength(1)
    })

    it('should call registered callbacks on sync events', async () => {
        const mockCallback = vi.fn()
        plugin.onEvent(mockCallback)
        ;(plugin as any).dataSource = mockDataSource

        const mockRows = [{ id: 1, name: 'Alice' }]

        mockRpc.executeQuery.mockResolvedValueOnce({ lastRowId: 1 })
        mockRpc.executeQuery.mockResolvedValueOnce([
            {
                id: 1,
                source_table: 'users',
                target_table: 'users_local',
                source_schema: 'public',
                primary_key: 'id',
                sync_interval_ms: 60000,
                last_synced_at: null,
                last_synced_cursor: null,
                is_active: 1,
            },
        ])
        mockRpc.executeQuery.mockResolvedValueOnce(mockRows)
        mockRpc.executeQuery.mockResolvedValueOnce([])
        mockRpc.executeQuery.mockResolvedValueOnce([])
        mockRpc.executeQuery.mockResolvedValueOnce([])

        await plugin.syncTable(1, 'full')

        expect(mockCallback).toHaveBeenCalledWith(
            expect.objectContaining({
                configId: 1,
                sourceTable: 'users',
                targetTable: 'users_local',
                syncType: 'full',
                status: 'success',
                rowsSynced: 1,
            })
        )
    })

    it('should handle callback errors without crashing', () => {
        const errorCallback = vi.fn().mockImplementation(() => {
            throw new Error('Callback error')
        })
        plugin.onEvent(errorCallback)

        // Should not throw
        expect(() => {
            ;(plugin as any).emitEvent({
                configId: 1,
                sourceTable: 'test',
                targetTable: 'test_local',
                syncType: 'full',
                rowsSynced: 0,
                status: 'success',
            })
        }).not.toThrow()
    })
})

describe('PostgresReplicationPlugin - Logs', () => {
    it('should return empty array when dataSource is not set', async () => {
        const logs = await plugin.getRecentLogs()
        expect(logs).toEqual([])
    })

    it('should fetch recent logs with default limit', async () => {
        ;(plugin as any).dataSource = mockDataSource
        const mockLogs = [
            {
                id: 1,
                config_id: 1,
                sync_type: 'full',
                rows_synced: 10,
                status: 'success',
                source_table: 'users',
                target_table: 'users_local',
            },
        ]
        mockRpc.executeQuery.mockResolvedValueOnce(mockLogs)

        const logs = await plugin.getRecentLogs()
        expect(logs).toEqual(mockLogs)

        const call = mockRpc.executeQuery.mock.calls[0]
        expect(call[0].params).toEqual([50])
    })
})
