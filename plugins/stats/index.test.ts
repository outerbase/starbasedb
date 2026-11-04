import { describe, it, expect, vi, beforeEach } from 'vitest'
import { StatsPlugin } from './index'

describe('StatsPlugin - Initialization', () => {
    it('should initialize with correct plugin name and options', () => {
        const plugin = new StatsPlugin()
        expect(plugin).toBeInstanceOf(StatsPlugin)
        expect(plugin.name).toBe('starbasedb:stats')
        expect(plugin.prefix).toBe('/_internal/stats')
        expect(plugin.options?.requiresAuth).toBe(true)
    })
})

describe('StatsPlugin - Route Registration and Handler', () => {
    let plugin: StatsPlugin
    let mockApp: any
    let registeredRoutes: Record<string, Function> = {}
    let registeredMiddleware: Function[] = []

    beforeEach(() => {
        plugin = new StatsPlugin()
        registeredRoutes = {}
        registeredMiddleware = []

        mockApp = {
            use: vi.fn((fn: Function) => {
                registeredMiddleware.push(fn)
            }),
            get: vi.fn((path: string, handler: Function) => {
                registeredRoutes[path] = handler
            }),
        }
    })

    it('should register middleware and GET route on app', async () => {
        await plugin.register(mockApp)

        expect(mockApp.use).toHaveBeenCalledTimes(1)
        expect(mockApp.get).toHaveBeenCalledWith('/_internal/stats', expect.any(Function))
        expect(registeredRoutes['/_internal/stats']).toBeDefined()
    })

    it('should reject requests with 400 if user role is not admin', async () => {
        await plugin.register(mockApp)

        // Simulate context with non-admin role
        const mockContext = {
            get: vi.fn((key: string) => {
                if (key === 'config') return { role: 'user' }
                return undefined
            }),
        }
        const mockNext = vi.fn()

        // Run middleware to set config
        await registeredMiddleware[0](mockContext, mockNext)

        // Invoke route handler
        const handler = registeredRoutes['/_internal/stats']
        const response: Response = await handler(mockContext, mockNext)

        expect(response.status).toBe(400)
        const text = await response.text()
        expect(text).toBe('Unauthorized request')
    })

    it('should return 200 and aggregated statistics for admin role', async () => {
        await plugin.register(mockApp)

        const mockStats = { uptime: 3600, totalQueries: 420 }
        const mockPlugins = ['starbasedb:stats', 'starbasedb:resend']

        const mockDataSource = {
            rpc: {
                getStatistics: vi.fn().mockResolvedValue(mockStats),
            },
            registry: {
                currentPlugins: vi.fn().mockReturnValue(mockPlugins),
            },
        }

        const mockContext = {
            get: vi.fn((key: string) => {
                if (key === 'config') return { role: 'admin' }
                if (key === 'dataSource') return mockDataSource
                return undefined
            }),
        }
        const mockNext = vi.fn()

        // Run middleware
        await registeredMiddleware[0](mockContext, mockNext)

        // Invoke route handler
        const handler = registeredRoutes['/_internal/stats']
        const response: Response = await handler(mockContext, mockNext)

        expect(response.status).toBe(200)
        expect(mockDataSource.rpc.getStatistics).toHaveBeenCalledTimes(1)
        expect(mockDataSource.registry.currentPlugins).toHaveBeenCalledTimes(1)
    })
})
