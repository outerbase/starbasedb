import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { ReplicationPlugin } from './index'
import type { DataSource } from '../../src/types'
import type { StarbaseDBConfiguration, StarbaseApp } from '../../src/handler'

vi.mock('../../src/operation', () => ({
    executeExternalQuery: vi.fn().mockResolvedValue([]),
}))

import { executeExternalQuery } from '../../src/operation'

// rpc.executeQuery is a Cloudflare Stub type at compile time but a Vitest mock at runtime.
// The double cast via unknown is required to access mock methods in tests.
type MockFn = ReturnType<typeof vi.fn>
const rpcMock = (ds: DataSource): MockFn =>
    ds.rpc.executeQuery as unknown as MockFn

function createMockDataSource(): DataSource {
    return {
        source: 'internal',
        external: {
            dialect: 'postgresql',
            host: 'mock-host',
            port: 5432,
            user: 'mock-user',
            password: 'mock-password',
            database: 'mock-db',
        } as any,
        rpc: {
            executeQuery: vi.fn().mockResolvedValue([]),
        } as any,
    } as DataSource
}

function createTestApp(
    config: StarbaseDBConfiguration,
    dataSource: DataSource
): StarbaseApp {
    const app = new Hono() as unknown as StarbaseApp
    app.use('*', async (c, next) => {
        c.set('config', config)
        c.set('dataSource', dataSource)
        await next()
    })
    return app
}

describe('ReplicationPlugin', () => {
    let mockDataSource: DataSource
    const adminConfig: StarbaseDBConfiguration = { role: 'admin' }
    const clientConfig: StarbaseDBConfiguration = { role: 'client' }

    beforeEach(() => {
        mockDataSource = createMockDataSource()
        vi.clearAllMocks()
    })

    describe('buildFetchQuery', () => {
        it('should build query without WHERE clause when no checkpoint exists', () => {
            const plugin = new ReplicationPlugin()
            const { sql, params } = (plugin as any).buildFetchQuery(
                'users',
                'id',
                null,
                500
            )
            expect(sql).toBe('SELECT * FROM users ORDER BY id ASC LIMIT ?')
            expect(params).toEqual([500])
        })

        it('should build query with WHERE clause when checkpoint value exists', () => {
            const plugin = new ReplicationPlugin()
            const { sql, params } = (plugin as any).buildFetchQuery(
                'users',
                'id',
                '42',
                100
            )
            expect(sql).toBe(
                'SELECT * FROM users WHERE id > ? ORDER BY id ASC LIMIT ?'
            )
            expect(params).toEqual(['42', 100])
        })

        it('should use provided cursor column and batch size', () => {
            const plugin = new ReplicationPlugin()
            const { sql, params } = (plugin as any).buildFetchQuery(
                'orders',
                'created_at',
                '2024-01-01',
                250
            )
            expect(sql).toBe(
                'SELECT * FROM orders WHERE created_at > ? ORDER BY created_at ASC LIMIT ?'
            )
            expect(params).toEqual(['2024-01-01', 250])
        })
    })

    describe('GET /replication/status', () => {
        it('should return 401 for non-admin role', async () => {
            const plugin = new ReplicationPlugin()
            const app = createTestApp(clientConfig, mockDataSource)
            await plugin.register(app)

            const response = await app.request('/replication/status')
            expect(response.status).toBe(401)
        })

        it('should return checkpoint data and plugin config for admin role', async () => {
            const checkpoints = [
                {
                    table_name: 'users',
                    cursor_column: 'id',
                    last_cursor_value: '10',
                    last_synced_at: '2024-01-01T00:00:00',
                    rows_synced: 10,
                },
            ]

            rpcMock(mockDataSource)
                .mockResolvedValueOnce([]) // CREATE_CHECKPOINT_TABLE
                .mockResolvedValueOnce(checkpoints) // GET_ALL_CHECKPOINTS

            const plugin = new ReplicationPlugin({ tables: ['users'] })
            const app = createTestApp(adminConfig, mockDataSource)
            await plugin.register(app)

            const response = await app.request('/replication/status')
            expect(response.status).toBe(200)

            const body = (await response.json()) as any
            expect(body.result.checkpoints).toEqual(checkpoints)
            expect(body.result.config).toBeDefined()
            expect(body.result.config.tables).toEqual(['users'])
        })
    })

    describe('POST /replication/run', () => {
        it('should return 401 for non-admin role', async () => {
            const plugin = new ReplicationPlugin()
            const app = createTestApp(clientConfig, mockDataSource)
            await plugin.register(app)

            const response = await app.request('/replication/run', {
                method: 'POST',
            })
            expect(response.status).toBe(401)
        })

        it('should return success JSON and start replication', async () => {
            const plugin = new ReplicationPlugin()
            const app = createTestApp(adminConfig, mockDataSource)
            await plugin.register(app)

            const response = await app.request('/replication/run', {
                method: 'POST',
            })
            expect(response.status).toBe(200)

            const body = (await response.json()) as any
            expect(body.result.success).toBe(true)
            expect(body.result.message).toBe('Replication started')
        })

        it('should call waitUntil with sync promise when executionContext is provided', async () => {
            const waitUntilMock = vi.fn()
            const mockCtx = {
                waitUntil: waitUntilMock,
            } as unknown as ExecutionContext

            const plugin = new ReplicationPlugin({ ctx: mockCtx })
            const app = createTestApp(adminConfig, mockDataSource)
            await plugin.register(app)

            await app.request('/replication/run', { method: 'POST' })

            expect(waitUntilMock).toHaveBeenCalledWith(expect.any(Promise))
        })
    })

    describe('sync - checkpoint upsert logic', () => {
        it('should upsert checkpoint with correct SQL and params after syncing rows', async () => {
            const plugin = new ReplicationPlugin({
                tables: ['users'],
                cursorColumn: 'id',
                batchSize: 100,
            })

            ;(plugin as any).dataSource = mockDataSource
            ;(plugin as any).config = adminConfig

            vi.mocked(executeExternalQuery).mockResolvedValueOnce([
                { id: 5, name: 'Alice' },
            ])

            rpcMock(mockDataSource)
                .mockResolvedValueOnce([]) // GET_CHECKPOINT (no existing checkpoint)
                .mockResolvedValueOnce(undefined) // INSERT OR REPLACE users row
                .mockResolvedValueOnce(undefined) // UPSERT_CHECKPOINT

            await (plugin as any).sync()

            const calls = rpcMock(mockDataSource).mock.calls

            const checkpointCall = calls.find((call: any[]) => {
                const opts = call[0] as { sql: string; params: unknown[] }
                return opts.sql.includes(
                    'INSERT OR REPLACE INTO tmp_replication_checkpoints'
                )
            })

            expect(checkpointCall).toBeDefined()
            const opts = checkpointCall![0] as {
                sql: string
                params: unknown[]
            }
            expect(opts.params[0]).toBe('users') // table_name
            expect(opts.params[1]).toBe('id') // cursor_column
            expect(opts.params[2]).toBe('5') // last_cursor_value (stringified)
            expect(opts.params[3]).toBe(1) // rows_synced
        })

        it('should accumulate rows_synced across multiple syncs', async () => {
            const plugin = new ReplicationPlugin({
                tables: ['users'],
                cursorColumn: 'id',
                batchSize: 100,
            })

            ;(plugin as any).dataSource = mockDataSource
            ;(plugin as any).config = adminConfig

            vi.mocked(executeExternalQuery).mockResolvedValueOnce([
                { id: 10, name: 'Bob' },
            ])

            rpcMock(mockDataSource)
                .mockResolvedValueOnce([
                    {
                        table_name: 'users',
                        cursor_column: 'id',
                        last_cursor_value: '5',
                        rows_synced: 1,
                    },
                ]) // GET_CHECKPOINT returns existing checkpoint
                .mockResolvedValueOnce(undefined) // INSERT OR REPLACE
                .mockResolvedValueOnce(undefined) // UPSERT_CHECKPOINT

            await (plugin as any).sync()

            const calls = rpcMock(mockDataSource).mock.calls

            const checkpointCall = calls.find((call: any[]) => {
                const opts = call[0] as { sql: string; params: unknown[] }
                return opts.sql.includes(
                    'INSERT OR REPLACE INTO tmp_replication_checkpoints'
                )
            })

            expect(checkpointCall).toBeDefined()
            const opts = checkpointCall![0] as {
                sql: string
                params: unknown[]
            }
            expect(opts.params[2]).toBe('10') // last_cursor_value updated
            expect(opts.params[3]).toBe(2) // rows_synced = 1 previous + 1 new
        })
    })

    describe('Idempotency', () => {
        it('should use INSERT OR REPLACE to avoid duplicates when syncing the same rows twice', async () => {
            const plugin = new ReplicationPlugin({
                tables: ['users'],
                cursorColumn: 'id',
                batchSize: 100,
            })

            ;(plugin as any).dataSource = mockDataSource
            ;(plugin as any).config = adminConfig

            const mockRows = [{ id: 1, name: 'Alice' }]

            // First sync
            vi.mocked(executeExternalQuery).mockResolvedValueOnce(mockRows)
            rpcMock(mockDataSource)
                .mockResolvedValueOnce([]) // GET_CHECKPOINT
                .mockResolvedValueOnce(undefined) // INSERT OR REPLACE row
                .mockResolvedValueOnce(undefined) // UPSERT_CHECKPOINT

            await (plugin as any).sync()

            const firstCalls = rpcMock(mockDataSource).mock.calls
            const firstUpsert = firstCalls.find((call: any[]) => {
                const opts = call[0] as { sql: string }
                return opts.sql.startsWith('INSERT OR REPLACE INTO users')
            })

            expect(firstUpsert).toBeDefined()
            expect((firstUpsert![0] as { sql: string }).sql).toContain(
                'INSERT OR REPLACE'
            )

            // Second sync with same rows — INSERT OR REPLACE guarantees no duplicates
            vi.clearAllMocks()
            vi.mocked(executeExternalQuery).mockResolvedValueOnce(mockRows)
            rpcMock(mockDataSource)
                .mockResolvedValueOnce([
                    {
                        table_name: 'users',
                        cursor_column: 'id',
                        last_cursor_value: '0',
                        rows_synced: 1,
                    },
                ]) // GET_CHECKPOINT
                .mockResolvedValueOnce(undefined) // INSERT OR REPLACE row
                .mockResolvedValueOnce(undefined) // UPSERT_CHECKPOINT

            await (plugin as any).sync()

            const secondCalls = rpcMock(mockDataSource).mock.calls
            const secondUpsert = secondCalls.find((call: any[]) => {
                const opts = call[0] as { sql: string }
                return opts.sql.startsWith('INSERT OR REPLACE INTO users')
            })

            expect(secondUpsert).toBeDefined()
            expect((secondUpsert![0] as { sql: string }).sql).toContain(
                'INSERT OR REPLACE'
            )
        })
    })

    describe('sync - non-Postgres source', () => {
        it('should skip sync and warn when external source is not PostgreSQL', async () => {
            const warnSpy = vi
                .spyOn(console, 'warn')
                .mockImplementation(() => {})

            const plugin = new ReplicationPlugin({ tables: ['users'] })

            ;(plugin as any).dataSource = {
                ...mockDataSource,
                external: { dialect: 'mysql' },
            }
            ;(plugin as any).config = adminConfig

            await (plugin as any).sync()

            expect(warnSpy).toHaveBeenCalledWith(
                expect.stringContaining('Only PostgreSQL')
            )
            expect(rpcMock(mockDataSource)).not.toHaveBeenCalled()
        })
    })
})
