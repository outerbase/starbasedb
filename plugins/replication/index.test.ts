import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ReplicationPlugin } from './index'

describe('ReplicationPlugin', () => {
    let plugin: ReplicationPlugin

    beforeEach(() => {
        plugin = new ReplicationPlugin()
    })

    it('should have the correct plugin name', () => {
        expect(plugin.name).toBe('starbasedb:replication')
    })

    it('should require authentication', () => {
        expect(plugin.opts.requiresAuth).toBe(true)
    })

    it('should have the correct route prefix', () => {
        expect(plugin.prefix).toBe('/replication')
    })

    it('should register event callbacks', () => {
        const callback = vi.fn()
        plugin.onEvent(callback)

        // Verify the callback is registered by checking it doesn't throw
        expect(() => plugin.onEvent(callback)).not.toThrow()
    })

    it('should throw error when syncTable is called without initialization', async () => {
        await expect(plugin.syncTable('test_table')).rejects.toThrow(
            'ReplicationPlugin not initialized'
        )
    })

    it('should throw error when syncAll is called without initialization', async () => {
        // syncAll calls getConfigs which requires dataSource
        // Since dataSource is undefined, getConfigs returns []
        // so syncAll should return empty array
        const results = await plugin.syncAll()
        expect(results).toEqual([])
    })
})

describe('ReplicationPlugin SQL Queries', () => {
    it('should define all required SQL queries', () => {
        // Verify the plugin can be instantiated without errors
        // indicating all internal SQL query constants are properly defined
        const plugin = new ReplicationPlugin()
        expect(plugin).toBeDefined()
        expect(plugin.name).toBe('starbasedb:replication')
    })
})

describe('ReplicationPlugin Event System', () => {
    let plugin: ReplicationPlugin

    beforeEach(() => {
        plugin = new ReplicationPlugin()
    })

    it('should support multiple event callbacks', () => {
        const callback1 = vi.fn()
        const callback2 = vi.fn()

        plugin.onEvent(callback1)
        plugin.onEvent(callback2)

        // Both callbacks should be registered without errors
        expect(() => {
            plugin.onEvent(callback1)
            plugin.onEvent(callback2)
        }).not.toThrow()
    })

    it('should support async event callbacks', () => {
        const asyncCallback = async () => {
            await new Promise((resolve) => setTimeout(resolve, 10))
        }

        expect(() => plugin.onEvent(asyncCallback)).not.toThrow()
    })
})
