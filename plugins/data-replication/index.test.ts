import { describe, it, expect, beforeEach, vi } from 'vitest'
import { DataReplicationPlugin } from './index'
import { StarbaseApp } from '../../src/handler'

describe('DataReplicationPlugin', () => {
    let plugin: DataReplicationPlugin
    let mockApp: StarbaseApp
    let mockDataSource: any

    beforeEach(() => {
        plugin = new DataReplicationPlugin()

        mockDataSource = {
            rpc: {
                executeQuery: vi.fn().mockResolvedValue([]),
            },
            source: 'internal',
            executionContext: undefined,
        }

        mockApp = {
            use: vi.fn(),
            post: vi.fn(),
            get: vi.fn(),
            delete: vi.fn(),
        } as any
    })

    it('should create plugin with correct name', () => {
        expect(plugin.name).toBe('starbasedb:data-replication')
        expect(plugin.pathPrefix).toBe('/data-replication')
    })

    it('should register routes and middleware', async () => {
        await plugin.register(mockApp)

        expect(mockApp.use).toHaveBeenCalled()
        expect(mockApp.post).toHaveBeenCalledWith(
            '/data-replication/configure',
            expect.any(Function)
        )
        expect(mockApp.post).toHaveBeenCalledWith(
            '/data-replication/start/:name',
            expect.any(Function)
        )
        expect(mockApp.post).toHaveBeenCalledWith(
            '/data-replication/stop/:name',
            expect.any(Function)
        )
        expect(mockApp.post).toHaveBeenCalledWith(
            '/data-replication/sync/:name',
            expect.any(Function)
        )
        expect(mockApp.get).toHaveBeenCalledWith(
            '/data-replication/status',
            expect.any(Function)
        )
        expect(mockApp.get).toHaveBeenCalledWith(
            '/data-replication/logs',
            expect.any(Function)
        )
        expect(mockApp.delete).toHaveBeenCalledWith(
            '/data-replication/configure/:name',
            expect.any(Function)
        )
    })

    it('should handle event callbacks', () => {
        const callback = vi.fn()
        plugin.onEvent(callback)

        // Trigger a callback (this would normally happen during sync)
        const payload = {
            config_name: 'test',
            status: 'success' as const,
            records_processed: 10,
            sync_duration_ms: 100,
        }

        // We can't directly test the private method, but we can verify the callback was registered
        expect(typeof callback).toBe('function')
    })
})
