import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SqlMacrosPlugin } from './index'
import type { StarbaseApp } from '../../src/handler'
import type { DataSource } from '../../src/types'

describe('SqlMacrosPlugin', () => {
    let plugin: SqlMacrosPlugin
    let mockDataSource: DataSource

    beforeEach(() => {
        vi.clearAllMocks()

        mockDataSource = {
            source: 'internal',
            rpc: {
                executeQuery: vi.fn().mockResolvedValue([
                    { column_name: 'id' },
                    { column_name: 'name' },
                    { column_name: 'password' },
                ]),
            },
        } as unknown as DataSource

        plugin = new SqlMacrosPlugin({ preventSelectStar: true })
        plugin.config = { role: 'client' }
    })

    it('should register middleware to capture config', async () => {
        const mockApp = {
            use: vi.fn((middleware) =>
                middleware({ get: vi.fn(() => ({ role: 'admin' })) }, vi.fn())
            ),
        } as unknown as StarbaseApp

        await plugin.register(mockApp)

        expect(plugin.config?.role).toBe('admin')
    })

    it('should throw error on SELECT * for non-admin when preventSelectStar is true', async () => {
        await expect(
            plugin.beforeQuery({
                sql: 'SELECT * FROM users',
                dataSource: mockDataSource,
            })
        ).rejects.toThrow('SELECT * is not allowed. Please specify explicit columns.')
    })

    it('should allow SELECT * when user role is admin', async () => {
        plugin.config = { role: 'admin' }

        const res = await plugin.beforeQuery({
            sql: 'SELECT * FROM users',
            dataSource: mockDataSource,
        })

        expect(res.sql).toBe('SELECT * FROM users')
    })

    it('should expand $_exclude macro to non-excluded columns for internal dataSource', async () => {
        const res = await plugin.beforeQuery({
            sql: 'SELECT $_exclude(password) FROM users',
            dataSource: mockDataSource,
        })

        expect(res.sql).toContain('id')
        expect(res.sql).toContain('name')
        expect(res.sql).not.toContain('password')
    })

    it('should return original SQL when dataSource is missing', async () => {
        const res = await plugin.beforeQuery({
            sql: 'SELECT * FROM users',
        })

        expect(res.sql).toBe('SELECT * FROM users')
    })
})
