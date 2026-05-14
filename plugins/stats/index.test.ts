import { describe, it, expect, vi, beforeEach } from 'vitest'
import { StatsPlugin } from './index'
import { StarbaseApp, StarbaseDBConfiguration } from '../../src/handler'
import { DataSource } from '../../src/types'

type MockApp = StarbaseApp & {
    capturedMiddleware?: (c: any, next: () => Promise<void>) => Promise<void>
    capturedGetHandler?: (
        c: any,
        next: () => Promise<void>
    ) => Promise<Response>
}

let statsPlugin: StatsPlugin
let mockApp: MockApp
let mockConfig: StarbaseDBConfiguration
let mockDataSource: DataSource

const createMockApp = () => {
    const app = {
        use: vi.fn((middleware) => {
            app.capturedMiddleware = middleware
        }),
        get: vi.fn((_path, handler) => {
            app.capturedGetHandler = handler
        }),
    } as MockApp

    return app
}

beforeEach(() => {
    vi.clearAllMocks()

    mockConfig = {
        role: 'admin',
    }
    mockDataSource = {
        rpc: {
            getStatistics: vi.fn().mockResolvedValue({
                reads: 12,
                writes: 4,
            }),
        },
        registry: {
            currentPlugins: vi
                .fn()
                .mockReturnValue(['starbasedb:stats', 'starbasedb:query-log']),
        },
    } as unknown as DataSource

    statsPlugin = new StatsPlugin()
    mockApp = createMockApp()
})

describe('StatsPlugin - Initialization', () => {
    it('should initialize with the internal stats prefix', () => {
        expect(statsPlugin).toBeInstanceOf(StatsPlugin)
        expect(statsPlugin.prefix).toBe('/_internal/stats')
        expect(statsPlugin.dataSource).toBeUndefined()
    })
})

describe('StatsPlugin - register()', () => {
    it('should capture request config and data source in middleware', async () => {
        const next = vi.fn().mockResolvedValue(undefined)

        await statsPlugin.register(mockApp)
        await mockApp.capturedMiddleware?.(
            {
                get: vi.fn((key: string) =>
                    key === 'config' ? mockConfig : mockDataSource
                ),
            },
            next
        )

        expect(statsPlugin['config']).toEqual(mockConfig)
        expect(statsPlugin.dataSource).toBe(mockDataSource)
        expect(next).toHaveBeenCalledTimes(1)
    })

    it('should register the stats endpoint', async () => {
        await statsPlugin.register(mockApp)

        expect(mockApp.get).toHaveBeenCalledWith(
            '/_internal/stats',
            expect.any(Function)
        )
    })
})

describe('StatsPlugin - stats route', () => {
    it('should reject non-admin users', async () => {
        await statsPlugin.register(mockApp)
        statsPlugin['config'] = { role: 'client' }
        statsPlugin.dataSource = mockDataSource

        const response = await mockApp.capturedGetHandler?.({}, vi.fn())

        expect(response?.status).toBe(400)
        await expect(response?.text()).resolves.toBe('Unauthorized request')
        expect(mockDataSource.rpc.getStatistics).not.toHaveBeenCalled()
    })

    it('should return internal stats and registered plugin names for admins', async () => {
        await statsPlugin.register(mockApp)
        statsPlugin['config'] = mockConfig
        statsPlugin.dataSource = mockDataSource

        const response = await mockApp.capturedGetHandler?.({}, vi.fn())

        expect(mockDataSource.rpc.getStatistics).toHaveBeenCalledTimes(1)
        expect(mockDataSource.registry?.currentPlugins).toHaveBeenCalledTimes(1)
        expect(response?.status).toBe(200)
        await expect(response?.json()).resolves.toEqual({
            result: {
                reads: 12,
                writes: 4,
                plugins: ['starbasedb:stats', 'starbasedb:query-log'],
            },
        })
    })

    it('should return an empty stats object when data source is unavailable', async () => {
        await statsPlugin.register(mockApp)
        statsPlugin['config'] = mockConfig
        statsPlugin.dataSource = undefined

        const response = await mockApp.capturedGetHandler?.({}, vi.fn())

        expect(response?.status).toBe(200)
        await expect(response?.json()).resolves.toEqual({
            result: {},
        })
    })
})
