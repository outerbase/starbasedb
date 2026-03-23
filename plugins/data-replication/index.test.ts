import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DataReplicationPlugin } from './index'
import type { ReplicationConfig } from './index'

describe('DataReplicationPlugin', () => {
    let plugin: DataReplicationPlugin

    beforeEach(() => {
        plugin = new DataReplicationPlugin()
    })

    it('should have the correct name', () => {
        expect(plugin.name).toBe('starbasedb:data-replication')
    })

    it('should require auth', () => {
        expect(plugin.opts.requiresAuth).toBe(true)
    })

    it('should have the correct path prefix', () => {
        expect(plugin.pathPrefix).toBe('/replication')
    })

    it('should return empty array when syncAll is called without data source', async () => {
        const results = await plugin.syncAll()
        expect(results).toEqual([])
    })

    describe('syncAll with mocked data source', () => {
        it('should skip tables that were recently replicated', async () => {
            const now = new Date()
                .toISOString()
                .replace('T', ' ')
                .replace('Z', '')
            const mockConfigs: ReplicationConfig[] = [
                {
                    table_name: 'users_replica',
                    source_table: 'public.users',
                    is_active: 1,
                    last_replicated_at: now,
                    interval_seconds: 3600,
                },
            ]

            const mockExecuteQuery = vi.fn().mockResolvedValue(mockConfigs)
            const mockDataSource = {
                rpc: { executeQuery: mockExecuteQuery },
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

            // Access private members for testing
            ;(plugin as any).dataSource = mockDataSource
            ;(plugin as any)._config = { role: 'admin' }

            const results = await plugin.syncAll()
            expect(results).toHaveLength(1)
            expect(results[0].status).toBe('skipped')
            expect(results[0].table).toBe('users_replica')
        })

        it('should replicate tables that have never been replicated', async () => {
            const mockConfigs: ReplicationConfig[] = [
                {
                    table_name: 'users_replica',
                    source_table: 'public.users',
                    is_active: 1,
                    last_replicated_at: null,
                    interval_seconds: 3600,
                },
            ]

            const mockExecuteQuery = vi
                .fn()
                .mockResolvedValueOnce(mockConfigs) // GET_ACTIVE_CONFIGS
                .mockResolvedValue([]) // subsequent calls

            const mockDataSource = {
                rpc: { executeQuery: mockExecuteQuery },
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

            ;(plugin as any).dataSource = mockDataSource
            ;(plugin as any)._config = { role: 'admin' }

            // Mock the external query module
            const operation = await import('../../src/operation')
            vi.spyOn(operation, 'executeExternalQuery').mockResolvedValue([
                { id: '1', name: 'Alice', email: 'alice@test.com' },
                { id: '2', name: 'Bob', email: 'bob@test.com' },
            ])

            const results = await plugin.syncAll()
            expect(results).toHaveLength(1)
            expect(results[0].status).toBe('success')
            expect(results[0].rows).toBe(2)
            expect(results[0].table).toBe('users_replica')

            // Verify the table was created and data inserted
            // executeQuery should have been called for: GET_ACTIVE_CONFIGS, DROP, CREATE, INSERT, UPDATE_LAST_REPLICATED
            expect(mockExecuteQuery).toHaveBeenCalledTimes(5)

            vi.restoreAllMocks()
        })

        it('should handle errors during replication gracefully', async () => {
            const mockConfigs: ReplicationConfig[] = [
                {
                    table_name: 'users_replica',
                    source_table: 'public.users',
                    is_active: 1,
                    last_replicated_at: null,
                    interval_seconds: 3600,
                },
            ]

            const mockExecuteQuery = vi.fn().mockResolvedValueOnce(mockConfigs)

            const mockDataSource = {
                rpc: { executeQuery: mockExecuteQuery },
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

            ;(plugin as any).dataSource = mockDataSource
            ;(plugin as any)._config = { role: 'admin' }

            const operation = await import('../../src/operation')
            vi.spyOn(operation, 'executeExternalQuery').mockRejectedValue(
                new Error('Connection refused')
            )

            const results = await plugin.syncAll()
            expect(results).toHaveLength(1)
            expect(results[0].status).toBe('error')
            expect(results[0].error).toBe('Connection refused')

            vi.restoreAllMocks()
        })

        it('should handle empty result from external source', async () => {
            const mockConfigs: ReplicationConfig[] = [
                {
                    table_name: 'empty_replica',
                    source_table: 'public.empty_table',
                    is_active: 1,
                    last_replicated_at: null,
                    interval_seconds: 3600,
                },
            ]

            const mockExecuteQuery = vi
                .fn()
                .mockResolvedValueOnce(mockConfigs)
                .mockResolvedValue([])

            const mockDataSource = {
                rpc: { executeQuery: mockExecuteQuery },
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

            ;(plugin as any).dataSource = mockDataSource
            ;(plugin as any)._config = { role: 'admin' }

            const operation = await import('../../src/operation')
            vi.spyOn(operation, 'executeExternalQuery').mockResolvedValue([])

            const results = await plugin.syncAll()
            expect(results).toHaveLength(1)
            expect(results[0].status).toBe('success')
            expect(results[0].rows).toBe(0)

            vi.restoreAllMocks()
        })
    })
})
