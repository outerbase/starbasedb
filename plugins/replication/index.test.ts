import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ReplicationPlugin } from './index'
import { executeSDKQuery } from '../../src/operation'

// Mock the operation module to mock executeSDKQuery
vi.mock('../../src/operation', () => ({
    executeSDKQuery: vi.fn(),
}))

describe('ReplicationPlugin', () => {
    let plugin: ReplicationPlugin
    let mockCronPlugin: any
    let mockDataSource: any
    let mockConfig: any

    beforeEach(() => {
        vi.clearAllMocks()

        mockCronPlugin = {
            onEvent: vi.fn(),
            addEvent: vi.fn(),
        }

        mockDataSource = {
            external: {
                dialect: 'postgresql',
                defaultSchema: 'public',
                database: 'testdb',
            },
            rpc: {
                executeQuery: vi.fn().mockResolvedValue([]),
                executeTransaction: vi.fn().mockResolvedValue([]),
                setAlarm: vi.fn().mockResolvedValue(undefined),
            },
        }

        mockConfig = {
            role: 'client',
        }

        plugin = new ReplicationPlugin({ cronPlugin: mockCronPlugin })
        plugin['dataSource'] = mockDataSource
        plugin['config'] = mockConfig
        plugin['env'] = {
            EXTERNAL_DB_TYPE: 'postgresql',
            EXTERNAL_DB_TABLES_TO_TRACK: 'users',
            EXTERNAL_DB_BATCH_SIZE: 5,
        }
    })

    it('should initialize correctly and register event callback', async () => {
        const mockApp = {
            use: vi.fn(),
        } as any

        await plugin.register(mockApp)

        expect(mockApp.use).toHaveBeenCalledTimes(1)
        expect(mockCronPlugin.onEvent).toHaveBeenCalledTimes(1)
    })

    it('should not run replication if already running', async () => {
        plugin['isRunning'] = true
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

        await plugin.runReplication()

        expect(logSpy).toHaveBeenCalledWith(
            'Database replication is already running. Skipping.'
        )
        logSpy.mockRestore()
    })

    it('should map postgres schema and create local table if it does not exist', async () => {
        // Mock query returned columns: id (INT), name (TEXT), updated_at (TIMESTAMP)
        vi.mocked(executeSDKQuery).mockResolvedValue([
            { column_name: 'id', data_type: 'integer', is_nullable: 'NO' },
            { column_name: 'name', data_type: 'text', is_nullable: 'YES' },
            {
                column_name: 'updated_at',
                data_type: 'timestamp',
                is_nullable: 'YES',
            },
        ] as any)

        mockDataSource.rpc.executeQuery.mockResolvedValue([])

        const moreData = await plugin['replicateTable']('users', 5)

        expect(moreData).toBe(false)
        expect(executeSDKQuery).toHaveBeenCalledWith(
            expect.objectContaining({
                sql: expect.stringContaining('information_schema.columns'),
            })
        )
        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledWith(
            expect.objectContaining({
                sql: expect.stringContaining(
                    'CREATE TABLE IF NOT EXISTS "users"'
                ),
            })
        )
    })

    it('should perform incremental polling using updated_at and id tie-breaker', async () => {
        // Schema lookup mock
        vi.mocked(executeSDKQuery).mockImplementation(async (opts: any) => {
            if (opts.sql.includes('information_schema.columns')) {
                return [
                    {
                        column_name: 'id',
                        data_type: 'integer',
                        is_nullable: 'NO',
                    },
                    {
                        column_name: 'name',
                        data_type: 'text',
                        is_nullable: 'YES',
                    },
                    {
                        column_name: 'updated_at',
                        data_type: 'timestamp',
                        is_nullable: 'YES',
                    },
                ]
            }
            if (opts.sql.includes('SELECT * FROM')) {
                // Mock return rows
                return [
                    {
                        id: 1,
                        name: 'Alice',
                        updated_at: '2026-06-13T10:00:00.000Z',
                    },
                    {
                        id: 2,
                        name: 'Bob',
                        updated_at: '2026-06-13T10:05:00.000Z',
                    },
                ]
            }
            return []
        })

        // Mock state retrieval (already has a watermark)
        mockDataSource.rpc.executeQuery.mockImplementation(
            async (opts: any) => {
                if (
                    opts.sql.includes('SELECT last_synced_id, last_synced_at')
                ) {
                    return [
                        {
                            last_synced_id: 1,
                            last_synced_at: '2026-06-13T09:00:00.000Z',
                        },
                    ]
                }
                return []
            }
        )

        const moreData = await plugin['replicateTable']('users', 5)

        // Since rows count (2) is less than batchSize (5), it should be false (no more data)
        expect(moreData).toBe(false)

        // Verify it queries with the correct parameters
        expect(executeSDKQuery).toHaveBeenCalledWith(
            expect.objectContaining({
                params: [
                    '2026-06-13T09:00:00.000Z',
                    '2026-06-13T09:00:00.000Z',
                    1,
                    5,
                ],
            })
        )

        // Verify transaction insert was run
        expect(mockDataSource.rpc.executeTransaction).toHaveBeenCalledTimes(1)
        expect(
            mockDataSource.rpc.executeTransaction.mock.calls[0][0]
        ).toHaveLength(2)

        // Verify replication state was updated
        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledWith(
            expect.objectContaining({
                sql: expect.stringContaining(
                    'INSERT OR REPLACE INTO tmp_replication_state'
                ),
                params: ['users', '2', '2026-06-13T10:05:00.000Z'],
            })
        )
    })

    it('should map values correctly to SQLite compatible types', async () => {
        // Mock columns
        vi.mocked(executeSDKQuery).mockImplementation(async (opts: any) => {
            if (opts.sql.includes('information_schema.columns')) {
                return [
                    {
                        column_name: 'id',
                        data_type: 'integer',
                        is_nullable: 'NO',
                    },
                    {
                        column_name: 'metadata',
                        data_type: 'jsonb',
                        is_nullable: 'YES',
                    },
                    {
                        column_name: 'is_active',
                        data_type: 'boolean',
                        is_nullable: 'YES',
                    },
                ]
            }
            if (opts.sql.includes('SELECT * FROM')) {
                return [{ id: 1, metadata: { role: 'admin' }, is_active: true }]
            }
            return []
        })

        mockDataSource.rpc.executeQuery.mockResolvedValue([])

        await plugin['replicateTable']('users', 5)

        // Verify transaction mapped the object metadata and boolean is_active
        expect(mockDataSource.rpc.executeTransaction).toHaveBeenCalledTimes(1)
        const queries = mockDataSource.rpc.executeTransaction.mock.calls[0][0]
        expect(queries[0].params).toEqual([1, '{"role":"admin"}', 1])
    })

    it('should sync hard deletions', async () => {
        // Mock columns
        vi.mocked(executeSDKQuery).mockImplementation(async (opts: any) => {
            if (opts.sql.includes('information_schema.columns')) {
                return [
                    {
                        column_name: 'id',
                        data_type: 'integer',
                        is_nullable: 'NO',
                    },
                ]
            }
            // First select rows: return empty to trigger deletion sync
            if (opts.sql.includes('SELECT * FROM')) {
                return []
            }
            // ID query from external: returns IDs 1 and 2
            if (opts.sql.includes('SELECT "id" FROM')) {
                return [{ id: 1 }, { id: 2 }]
            }
            return []
        })

        // SQLite local IDs: returns 1, 2, and 3 (3 was deleted in source)
        mockDataSource.rpc.executeQuery.mockImplementation(
            async (opts: any) => {
                if (
                    opts.sql.includes('SELECT last_synced_id, last_synced_at')
                ) {
                    return []
                }
                if (opts.sql.includes('SELECT "id" FROM "users"')) {
                    return [{ id: 1 }, { id: 2 }, { id: 3 }]
                }
                return []
            }
        )

        await plugin['replicateTable']('users', 5)

        // Verify DELETE query was executed for ID 3
        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledWith(
            expect.objectContaining({
                sql: expect.stringContaining(
                    'DELETE FROM "users" WHERE "id" IN (?)'
                ),
                params: [3],
            })
        )
    })
})
