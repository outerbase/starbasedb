import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { ReplicationPlugin } from './index'
import { StarbaseDBConfiguration } from '../../src/handler'
import { DataSource } from '../../src/types'
import * as operation from '../../src/operation'

vi.mock('../../src/operation', async () => {
    const actual = await vi.importActual<typeof import('../../src/operation')>(
        '../../src/operation'
    )
    return {
        ...actual,
        executeExternalQuery: vi.fn(),
    }
})

describe('ReplicationPlugin', () => {
    let plugin: ReplicationPlugin
    let mockExecuteQuery: ReturnType<typeof vi.fn>
    let mockExecuteTransaction: ReturnType<typeof vi.fn>
    let mockDataSource: DataSource
    let mockConfig: StarbaseDBConfiguration

    beforeEach(() => {
        vi.clearAllMocks()
        mockExecuteQuery = vi.fn().mockResolvedValue([])
        mockExecuteTransaction = vi.fn().mockResolvedValue([])

        mockDataSource = {
            source: 'internal',
            external: {
                dialect: 'sqlite',
                provider: 'turso',
                uri: 'libsql://example.turso.io',
                token: 'test-token',
            },
            rpc: {
                executeQuery: mockExecuteQuery,
                executeTransaction: mockExecuteTransaction,
            } as any,
        }

        mockConfig = {
            role: 'admin',
        }

        plugin = new ReplicationPlugin({
            tables: ['users'],
            intervalSeconds: 60,
            autoSyncOnQuery: false,
            batchSize: 2,
        })
    })

    it('should initialize with expected defaults and custom options', () => {
        expect(plugin.name).toBe('starbasedb:replication')
        expect(plugin.pathPrefix).toBe('/replication')
        expect(plugin.tables).toEqual(['users'])
        expect(plugin.intervalSeconds).toBe(60)
        expect(plugin.batchSize).toBe(2)

        const defaultPlugin = new ReplicationPlugin()
        expect(defaultPlugin.tables).toEqual([])
        expect(defaultPlugin.conflictStrategy).toBe('replace')
    })

    it('should replicate rows from external source into internal SQLite in batches', async () => {
        vi.mocked(operation.executeExternalQuery).mockResolvedValueOnce([
            { id: 1, name: 'Alice', active: true },
            { id: 2, name: 'Bob', active: false },
            { id: 3, name: 'Charlie', active: true },
        ])

        const results = await plugin.syncAll(mockDataSource, mockConfig)

        expect(results).toHaveLength(1)
        expect(results[0]).toMatchObject({
            table: 'users',
            rowsSynced: 3,
            status: 'synced',
        })

        expect(mockExecuteQuery).toHaveBeenCalledWith(
            expect.objectContaining({
                sql: expect.stringContaining(
                    'CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT, active INTEGER)'
                ),
            })
        )

        expect(mockExecuteTransaction).toHaveBeenCalledTimes(2)
        expect(mockExecuteTransaction.mock.calls[0][0]).toHaveLength(2)
        expect(mockExecuteTransaction.mock.calls[1][0]).toHaveLength(1)
    })

    it('should handle empty external tables gracefully', async () => {
        vi.mocked(operation.executeExternalQuery).mockResolvedValueOnce([])

        const results = await plugin.syncAll(mockDataSource, mockConfig)
        expect(results[0]).toMatchObject({
            table: 'users',
            rowsSynced: 0,
            status: 'empty',
        })
        expect(mockExecuteTransaction).not.toHaveBeenCalled()
    })

    it('should reject invalid SQL identifiers to prevent SQL injection', async () => {
        const res = await plugin.syncAll(mockDataSource, mockConfig, [
            'users; DROP TABLE users;--',
        ]).catch((e) => e)
        expect(res).toBeInstanceOf(Error)
        expect(res.message).toContain('Invalid SQL identifier')
    })

    it('should expose /replication/sync and /replication/status routes for admin', async () => {
        vi.mocked(operation.executeExternalQuery).mockResolvedValueOnce([
            { id: 10, title: 'Hello' },
        ])

        const app = new Hono<any>()
        app.use('*', async (c, next) => {
            c.set('dataSource', mockDataSource)
            c.set('config', mockConfig)
            await next()
        })
        await plugin.register(app as any)

        const syncResp = await app.request('/replication/sync', {
            method: 'POST',
            body: JSON.stringify({ tables: ['posts'] }),
        })
        expect(syncResp.status).toBe(200)
        const syncJson: any = await syncResp.json()
        expect(syncJson.result.success).toBe(true)
        expect(syncJson.result.results[0].table).toBe('posts')

        const statusResp = await app.request('/replication/status', {
            method: 'GET',
        })
        expect(statusResp.status).toBe(200)
        const statusJson: any = await statusResp.json()
        expect(statusJson.result.configuredTables).toEqual(['users'])
    })

    it('should block non-admin requests to /replication/sync and /replication/status', async () => {
        const app = new Hono<any>()
        app.use('*', async (c, next) => {
            c.set('dataSource', mockDataSource)
            c.set('config', { role: 'client' })
            await next()
        })
        await plugin.register(app as any)

        const syncResp = await app.request('/replication/sync', {
            method: 'POST',
        })
        expect(syncResp.status).toBe(401)

        const statusResp = await app.request('/replication/status', {
            method: 'GET',
        })
        expect(statusResp.status).toBe(401)
    })

    it('should auto-sync on beforeQuery when autoSyncOnQuery is enabled', async () => {
        const autoPlugin = new ReplicationPlugin({
            tables: ['users'],
            intervalSeconds: 60,
            autoSyncOnQuery: true,
        })

        vi.mocked(operation.executeExternalQuery).mockResolvedValue([
            { id: 1, name: 'Alice' },
        ])

        await autoPlugin.beforeQuery({
            sql: 'SELECT * FROM users',
            dataSource: mockDataSource,
            config: mockConfig,
        })
        expect(operation.executeExternalQuery).toHaveBeenCalledTimes(1)

        await autoPlugin.beforeQuery({
            sql: 'SELECT * FROM users',
            dataSource: mockDataSource,
            config: mockConfig,
        })
        expect(operation.executeExternalQuery).toHaveBeenCalledTimes(1)
    })
})
