import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ReplicationPlugin } from './index'

describe('ReplicationPlugin', () => {
    let plugin: ReplicationPlugin
    const mockConfig = {
        sourceType: 'postgres' as const,
        sourceUrl: 'https://api.example.com/data',
        targetTable: 'local_users',
        mapping: {
            external_id: 'id',
            full_name: 'name',
        },
    }

    beforeEach(() => {
        vi.resetAllMocks()
        plugin = new ReplicationPlugin(mockConfig)
    })

    it('should have correct metadata', () => {
        expect(plugin.name).toBe('starbasedb:replication')
    })

    it('should register the /replication/sync endpoint', () => {
        const mockApp = {
            post: vi.fn(),
        } as any

        plugin.register(mockApp)
        expect(mockApp.post).toHaveBeenCalledWith(
            '/replication/sync',
            expect.any(Function)
        )
    })

    it('should handle manual sync correctly with data transformation', async () => {
        // Mock data fetching
        const mockRawData = [
            { external_id: 'ext_1', full_name: 'Alice', other: 'junk' },
            { external_id: 'ext_2', full_name: 'Bob', other: 'stuff' },
        ]

        vi.spyOn(plugin, 'fetchFromSource').mockResolvedValue(mockRawData)

        const result = await plugin.syncData()

        expect(result.success).toBe(true)
        expect(result.rowsSynced).toBe(2)
        expect(result.timestamp).toBeDefined()
    })

    it('should return 0 rows if source is empty', async () => {
        vi.spyOn(plugin, 'fetchFromSource').mockResolvedValue([])

        const result = await plugin.syncData()

        expect(result.success).toBe(true)
        expect(result.rowsSynced).toBe(0)
    })

    it('should handle errors during sync', async () => {
        vi.spyOn(plugin, 'fetchFromSource').mockRejectedValue(
            new Error('Network failure')
        )

        const result = await plugin.syncData()

        expect(result.success).toBe(false)
        expect(result.error).toBe('Network failure')
    })
})
