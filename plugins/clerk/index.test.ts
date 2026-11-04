import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ClerkPlugin } from './index'

describe('ClerkPlugin - Initialization', () => {
    it('should initialize with correct plugin name and keys', () => {
        const plugin = new ClerkPlugin({
            secretKey: 'sk_test_clerk_secret',
            publishableKey: 'pk_test_clerk_pub',
        })
        expect(plugin).toBeInstanceOf(ClerkPlugin)
        expect(plugin.name).toBe('starbasedb:clerk')
        expect(plugin.secretKey).toBe('sk_test_clerk_secret')
        expect(plugin.publishableKey).toBe('pk_test_clerk_pub')
    })

    it('should initialize gracefully when options are not passed', () => {
        const plugin = new ClerkPlugin()
        expect(plugin).toBeInstanceOf(ClerkPlugin)
        expect(plugin.secretKey).toBeUndefined()
        expect(plugin.publishableKey).toBeUndefined()
    })
})

describe('ClerkPlugin - App Registration', () => {
    let plugin: ClerkPlugin
    let mockApp: any

    beforeEach(() => {
        plugin = new ClerkPlugin({ secretKey: 'sk_test_123' })
        mockApp = {
            use: vi.fn(),
            post: vi.fn(),
            get: vi.fn(),
        }
    })

    it('should register middleware and endpoints on app instance', async () => {
        await plugin.register(mockApp)
        expect(mockApp.use).toHaveBeenCalled()
    })
})
