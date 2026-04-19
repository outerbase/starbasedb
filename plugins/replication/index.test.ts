import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ReplicationPlugin } from './index'

describe('ReplicationPlugin', () => {
    let plugin: ReplicationPlugin
    let mockDataSource: any

    beforeEach(() => {
        mockDataSource = {
            rpc: {
                executeQuery: vi.fn().mockResolvedValue([]),
                setAlarm: vi.fn().mockResolvedValue(undefined),
            },
        }

        plugin = new ReplicationPlugin({
            intervalMs: 60000,
            tables: [
                {
                    sourceTable: 'users',
                    targetTable: 'users',
                    trackingColumn: 'id',
                },
            ],
        })
    })

    describe('constructor', () => {
        it('should create plugin with correct name', () => {
            expect(plugin.name).toBe('starbasedb:replication')
        })

        it('should set default config values', () => {
            const p = new ReplicationPlugin({
                tables: [{ sourceTable: 'test' }],
            })
            // @ts-ignore - accessing private for testing
            expect(p.replicationConfig.intervalMs).toBe(60000)
            // @ts-ignore
            expect(p.replicationConfig.batchSize).toBe(1000)
            // @ts-ignore
            expect(p.replicationConfig.conflictStrategy).toBe('replace')
        })

        it('should override default config values', () => {
            const p = new ReplicationPlugin({
                intervalMs: 30000,
                batchSize: 500,
                conflictStrategy: 'ignore',
                tables: [{ sourceTable: 'test' }],
            })
            // @ts-ignore
            expect(p.replicationConfig.intervalMs).toBe(30000)
            // @ts-ignore
            expect(p.replicationConfig.batchSize).toBe(500)
            // @ts-ignore
            expect(p.replicationConfig.conflictStrategy).toBe('ignore')
        })
    })

    describe('getStates', () => {
        it('should return empty array when no data source', async () => {
            const result = await plugin.getStates()
            expect(result).toEqual([])
        })

        it('should query replication states', async () => {
            // @ts-ignore
            plugin.dataSource = mockDataSource
            mockDataSource.rpc.executeQuery.mockResolvedValue([
                { source_table: 'users', target_table: 'users', status: 'active' },
            ])

            const result = await plugin.getStates()
            expect(result).toHaveLength(1)
            expect(result[0].source_table).toBe('users')
        })
    })

    describe('getLogs', () => {
        it('should return empty array when no data source', async () => {
            const result = await plugin.getLogs()
            expect(result).toEqual([])
        })

        it('should query replication logs with limit', async () => {
            // @ts-ignore
            plugin.dataSource = mockDataSource
            mockDataSource.rpc.executeQuery.mockResolvedValue([])

            await plugin.getLogs(10)
            expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledWith(
                expect.objectContaining({
                    params: [10],
                })
            )
        })
    })

    describe('syncTable', () => {
        it('should return error when no data source', async () => {
            const result = await plugin.syncTable({ sourceTable: 'users' })
            expect(result.error).toBeDefined()
            expect(result.rowsSynced).toBe(0)
        })
    })
})
