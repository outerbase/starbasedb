import { describe, it, expect, vi, beforeEach } from 'vitest'
import { StripePlugin } from './index'

describe('StripePlugin - Initialization', () => {
    it('should initialize with correct plugin name and options', () => {
        const plugin = new StripePlugin({
            apiKey: 'sk_test_123',
            endpointSecret: 'whsec_abc',
        })
        expect(plugin).toBeInstanceOf(StripePlugin)
        expect(plugin.name).toBe('starbasedb:stripe')
        expect(plugin.apiKey).toBe('sk_test_123')
        expect(plugin.endpointSecret).toBe('whsec_abc')
    })

    it('should initialize with empty options without throwing', () => {
        const plugin = new StripePlugin()
        expect(plugin).toBeInstanceOf(StripePlugin)
        expect(plugin.apiKey).toBeUndefined()
        expect(plugin.endpointSecret).toBeUndefined()
    })
})

describe('StripePlugin - Route Registration', () => {
    let plugin: StripePlugin
    let mockApp: any
    let registeredRoutes: Record<string, Function> = {}

    beforeEach(() => {
        plugin = new StripePlugin({ apiKey: 'sk_test_123' })
        registeredRoutes = {}

        mockApp = {
            use: vi.fn(),
            post: vi.fn((path: string, handler: Function) => {
                registeredRoutes[path] = handler
            }),
        }
    })

    it('should register webhook endpoints on app', async () => {
        await plugin.register(mockApp)
        expect(mockApp.use).toHaveBeenCalled()
    })
})
