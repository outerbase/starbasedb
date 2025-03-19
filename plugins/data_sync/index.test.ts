import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import DataSyncPlugin from './index'
import type { PluginContext } from './index'

describe('DataSyncPlugin Integration Tests', () => {
    let plugin: DataSyncPlugin
    let mockContext: PluginContext

    beforeEach(() => {
        mockContext = {
            env: {
                EXTERNAL_DB_TYPE: 'postgresql',
                EXTERNAL_DB_HOST: 'localhost',
                EXTERNAL_DB_PORT: '5432',
                EXTERNAL_DB_USER: 'postgres',
                EXTERNAL_DB_PASS: 'postgres',
                EXTERNAL_DB_DATABASE: 'starbase_demo',
            },
            config: {
                sync_interval: 5,
                tables: ['users', 'products'],
                batch_size: 100,
                enabled: true,
            },
            internalDb: {
                executeQuery: vi.fn().mockImplementation((query) => {
                    // Return empty array for metadata operations
                    if (query.sql.includes('data_sync_metadata')) {
                        return Promise.resolve([])
                    }
                    // Return success for table creation
                    if (query.sql.includes('CREATE TABLE')) {
                        return Promise.resolve([])
                    }
                    // Return empty array for other queries
                    return Promise.resolve([])
                }),
                getAlarm: vi.fn().mockResolvedValue(null),
                setAlarm: vi.fn().mockResolvedValue(undefined),
                deleteAlarm: vi.fn().mockResolvedValue(undefined),
            },
            externalDb: {
                executeQuery: vi.fn().mockImplementation((query) => {
                    // Return table list
                    if (query.sql.includes('information_schema.tables')) {
                        return Promise.resolve([{ table_name: 'users' }])
                    }
                    // Return schema for users table
                    if (query.sql.includes('information_schema.columns')) {
                        return Promise.resolve([
                            {
                                name: 'id',
                                type: 'integer',
                                nullable: 'NO',
                                default_value: null,
                            },
                            {
                                name: 'name',
                                type: 'text',
                                nullable: 'NO',
                                default_value: null,
                            },
                        ])
                    }
                    // Return sample data
                    if (query.sql.includes('SELECT * FROM users')) {
                        return Promise.resolve([{ id: 1, name: 'Test User' }])
                    }
                    return Promise.resolve([])
                }),
            },
        }

        plugin = new DataSyncPlugin()
    })

    afterEach(() => {
        vi.clearAllMocks()
    })

    it('should initialize and sync data', async () => {
        await plugin.initialize(mockContext)
        await plugin.triggerSync()

        const { executeQuery } = mockContext.internalDb
        const calls = vi.mocked(executeQuery).mock.calls

        // Verify metadata table creation
        expect(
            calls.some((call) =>
                call[0].sql.includes(
                    'CREATE TABLE IF NOT EXISTS data_sync_metadata'
                )
            )
        ).toBe(true)

        // Verify schema queries in correct order
        if (mockContext.externalDb?.executeQuery) {
            const externalCalls = vi.mocked(mockContext.externalDb.executeQuery)
                .mock.calls

            // First call should be for table list
            expect(externalCalls[0][0].sql).toContain(
                'information_schema.tables'
            )

            // Second call should be for column information
            expect(externalCalls[1][0].sql).toContain(
                'information_schema.columns'
            )
        }
    })

    it('should handle errors', async () => {
        // Create a spy for console.error
        const consoleErrorSpy = vi.spyOn(console, 'error')

        if (mockContext.externalDb) {
            // Mock the external DB to reject with an error
            mockContext.externalDb.executeQuery = vi
                .fn()
                .mockRejectedValue(new Error('Database error'))
        }

        await plugin.initialize(mockContext)
        await plugin.triggerSync()

        // Verify that the error was logged
        expect(consoleErrorSpy).toHaveBeenCalledWith(
            'Data Sync Plugin: Failed to get table list',
            expect.any(Error)
        )

        // Restore the console.error spy
        consoleErrorSpy.mockRestore()
    })
})
