import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ReplicationPlugin } from './index'
import { StarbaseApp, StarbaseDBConfiguration } from '../../src/handler'
import { DataSource } from '../../src/types'
import * as operation from '../../src/operation'

vi.mock('../../src/operation', () => ({
    executeExternalQuery: vi.fn(),
}))

describe('ReplicationPlugin', () => {
    let plugin: ReplicationPlugin
    let mockDataSource: DataSource
    let mockConfig: StarbaseDBConfiguration

    beforeEach(() => {
        vi.clearAllMocks()

        mockDataSource = {
            rpc: {
                executeQuery: vi.fn().mockResolvedValue([]),
            },
            source: 'internal',
        } as unknown as DataSource

        mockConfig = {
            role: 'admin',
            outerbaseApiKey: 'test-key',
        }

        plugin = new ReplicationPlugin({
            tables: [
                {
                    table: 'users',
                    cursorColumn: 'id',
                    primaryKey: 'id',
                    intervalSeconds: 60,
                    batchSize: 100,
                },
                'orders',
            ],
            intervalSeconds: 300,
            batchSize: 500,
        })
    })

    it('should initialize with normalized table configs', () => {
        expect(plugin.name).toBe('starbasedb:replication')
        expect(plugin.pathPrefix).toBe('/replication')
        expect(plugin.tables).toHaveLength(2)
        expect(plugin.tables[0].table).toBe('users')
        expect(plugin.tables[0].cursorColumn).toBe('id')
        expect(plugin.tables[0].intervalSeconds).toBe(60)
        expect(plugin.tables[1].table).toBe('orders')
        expect(plugin.tables[1].intervalSeconds).toBe(300)
    })

    it('should create replication state table on register middleware', async () => {
        const mockApp = {
            use: vi.fn((_path, middleware) =>
                middleware(
                    {
                        get: vi.fn((key: string) =>
                            key === 'dataSource' ? mockDataSource : mockConfig
                        ),
                    },
                    vi.fn()
                )
            ),
            get: vi.fn(),
            post: vi.fn(),
        } as unknown as StarbaseApp

        await plugin.register(mockApp)

        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: expect.stringContaining(
                'CREATE TABLE IF NOT EXISTS tmp_replication_state'
            ),
            params: [],
        })
    })

    it('should pull external rows and insert into internal SQLite with cursor tracking', async () => {
        plugin['dataSource'] = mockDataSource
        plugin['config'] = mockConfig

        vi.mocked(operation.executeExternalQuery).mockResolvedValueOnce([
            { id: 10, name: 'Alice', active: true },
            { id: 11, name: 'Bob', active: false },
        ])

        const res = await plugin.syncTable(plugin.tables[0], true)

        expect(operation.executeExternalQuery).toHaveBeenCalledWith({
            sql: 'SELECT * FROM users ORDER BY id ASC LIMIT 100',
            params: [],
            dataSource: mockDataSource,
            config: mockConfig,
        })
        expect(res).toEqual({
            table: 'users',
            syncedRows: 2,
            lastCursorValue: '11',
            skipped: false,
        })
        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: expect.stringContaining('CREATE TABLE IF NOT EXISTS "users"'),
            params: [],
        })
        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: 'INSERT OR REPLACE INTO "users" ("id", "name", "active") VALUES (?, ?, ?)',
            params: [10, 'Alice', 1],
        })
        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: 'INSERT OR REPLACE INTO "users" ("id", "name", "active") VALUES (?, ?, ?)',
            params: [11, 'Bob', 0],
        })
    })

    it('should use incremental WHERE cursorColumn > ? when last_cursor_value exists', async () => {
        plugin['dataSource'] = mockDataSource
        plugin['config'] = mockConfig

        vi.mocked(mockDataSource.rpc.executeQuery)
            .mockResolvedValueOnce([]) // CREATE_STATE_TABLE
            .mockResolvedValueOnce([
                {
                    table_name: 'users',
                    cursor_column: 'id',
                    last_cursor_value: '11',
                    last_synced_at: 1000,
                    rows_synced: 2,
                },
            ])

        vi.mocked(operation.executeExternalQuery).mockResolvedValueOnce([
            { id: 12, name: 'Charlie', active: true },
        ])

        const res = await plugin.syncTable(plugin.tables[0], false)

        expect(operation.executeExternalQuery).toHaveBeenCalledWith({
            sql: 'SELECT * FROM users WHERE id > ? ORDER BY id ASC LIMIT 100',
            params: ['11'],
            dataSource: mockDataSource,
            config: mockConfig,
        })
        expect(res.syncedRows).toBe(1)
        expect(res.lastCursorValue).toBe('12')
    })

    it('should skip sync when within configured intervalSeconds and force is false', async () => {
        plugin['dataSource'] = mockDataSource
        plugin['config'] = mockConfig

        vi.mocked(mockDataSource.rpc.executeQuery)
            .mockResolvedValueOnce([]) // CREATE_STATE_TABLE
            .mockResolvedValueOnce([
                {
                    table_name: 'users',
                    cursor_column: 'id',
                    last_cursor_value: '12',
                    last_synced_at: Date.now(),
                    rows_synced: 3,
                },
            ])

        const res = await plugin.syncTable(plugin.tables[0], false)

        expect(res.skipped).toBe(true)
        expect(operation.executeExternalQuery).not.toHaveBeenCalled()
    })
})
