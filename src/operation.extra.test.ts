import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DataSource } from './types'

// Setup mocks first before importing operation
vi.mock('@outerbase/sdk', () => {
    class MockConnection {
        connect = vi.fn().mockResolvedValue(undefined)
        raw = vi
            .fn()
            .mockResolvedValue({ data: [{ id: 1, name: 'SDK-Result' }] })
    }
    return {
        PostgreSQLConnection: MockConnection,
        MySQLConnection: MockConnection,
        CloudflareD1Connection: MockConnection,
        StarbaseConnection: MockConnection,
        TursoConnection: MockConnection,
    }
})

vi.mock('pg', () => ({ Client: class {} }))
vi.mock('mysql2', () => ({ createConnection: vi.fn() }))
vi.mock('@libsql/client/web', () => ({ createClient: vi.fn() }))

vi.mock('postgres', () => ({
    default: vi.fn(() => ({
        unsafe: vi.fn().mockResolvedValue([{ id: 1, name: 'hyperdrive-res' }]),
        end: vi.fn().mockResolvedValue(undefined),
    })),
}))

import { executeQuery, executeSDKQuery } from './operation'

describe('operation additional tests', () => {
    let mockDataSource: DataSource

    beforeEach(() => {
        vi.clearAllMocks()
        mockDataSource = {
            source: 'internal',
            cache: false,
            rpc: {
                executeQuery: vi.fn().mockResolvedValue([{ id: 1 }]),
            },
        } as any
    })

    it('should handle isRaw=true', async () => {
        const result = await executeQuery({
            sql: 'SELECT 1',
            params: [],
            isRaw: true,
            dataSource: mockDataSource,
            config: {} as any,
        })
        expect(result).toHaveProperty('columns')
        expect(result).toHaveProperty('rows')
    })

    it('should handle hyperdrive source', async () => {
        mockDataSource.source = 'hyperdrive'
        mockDataSource.external = {
            dialect: 'postgresql',
            connectionString: 'postgres://user:pass@host/db',
        } as any

        const result = await executeQuery({
            sql: 'SELECT 1',
            params: [],
            isRaw: false,
            dataSource: mockDataSource,
            config: {} as any,
        })
        expect(result).toEqual([{ id: 1, name: 'hyperdrive-res' }])
    })

    it('should handle SDK queries for Postgres', async () => {
        mockDataSource.source = 'external'
        mockDataSource.external = { dialect: 'postgresql', host: 'host' } as any

        const result = await executeSDKQuery({
            sql: 'SELECT 1',
            dataSource: mockDataSource,
            config: {} as any,
        })
        expect(result).toEqual([{ id: 1, name: 'SDK-Result' }])
    })

    it('should handle SDK queries for MySQL', async () => {
        mockDataSource.source = 'external'
        mockDataSource.external = { dialect: 'mysql', host: 'host' } as any

        const result = await executeSDKQuery({
            sql: 'SELECT 1',
            dataSource: mockDataSource,
            config: {} as any,
        })
        expect(result).toEqual([{ id: 1, name: 'SDK-Result' }])
    })

    it('should handle SDK queries for D1', async () => {
        mockDataSource.source = 'external'
        mockDataSource.external = { provider: 'cloudflare-d1' } as any

        const result = await executeSDKQuery({
            sql: 'SELECT 1',
            dataSource: mockDataSource,
            config: {} as any,
        })
        expect(result).toEqual([{ id: 1, name: 'SDK-Result' }])
    })

    it('should handle SDK queries for Turso', async () => {
        mockDataSource.source = 'external'
        mockDataSource.external = { provider: 'turso' } as any

        const result = await executeSDKQuery({
            sql: 'SELECT 1',
            dataSource: mockDataSource,
            config: {} as any,
        })
        expect(result).toEqual([{ id: 1, name: 'SDK-Result' }])
    })

    it('should handle SDK queries for Starbase', async () => {
        mockDataSource.source = 'external'
        mockDataSource.external = { provider: 'starbase' } as any

        const result = await executeSDKQuery({
            sql: 'SELECT 1',
            dataSource: mockDataSource,
            config: {} as any,
        })
        expect(result).toEqual([{ id: 1, name: 'SDK-Result' }])
    })

    it('should throw for unsupported DB', async () => {
        mockDataSource.source = 'external'
        mockDataSource.external = { provider: 'unknown' } as any

        await expect(
            executeSDKQuery({
                sql: 'SELECT 1',
                dataSource: mockDataSource,
                config: {} as any,
            })
        ).rejects.toThrow('Unsupported external database type')
    })
})
