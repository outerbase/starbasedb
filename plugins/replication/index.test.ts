import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ReplicationPlugin } from './index'
import { Hono } from 'hono'
import type { DataSource } from '../../src/types'
import type { StarbaseDBConfiguration, StarbaseApp } from '../../src/handler'

// Mock the operation module
vi.mock('../../src/operation', () => ({
    executeQuery: vi.fn(),
}))

vi.mock('../../src/utils', () => ({
    createResponse: vi.fn(
        (data, message, status) =>
            new Response(JSON.stringify({ result: data, error: message }), {
                status,
                headers: { 'Content-Type': 'application/json' },
            })
    ),
}))

import { executeQuery } from '../../src/operation'

type MockFn = ReturnType<typeof vi.fn>
const rpcMock = (ds: DataSource): MockFn =>
    ds.rpc.executeQuery as unknown as MockFn

// State variables to control mock return values dynamically
let mockLastRunAt: string | null = null
let mockLastCursor: string | null = null
let mockAllConfigs: any[] = []

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
            executeQuery: vi.fn().mockImplementation(async (opts: any) => {
                const sql = opts.sql
                if (
                    sql.includes(
                        'SELECT last_run_at FROM tmp_replicate_cursors'
                    )
                ) {
                    return [{ last_run_at: mockLastRunAt }]
                }
                if (
                    sql.includes(
                        'SELECT last_cursor FROM tmp_replicate_cursors'
                    )
                ) {
                    return [{ last_cursor: mockLastCursor }]
                }
                if (
                    sql.includes(
                        'SELECT table_name, cursor_column, last_cursor, last_run_at, rows_replicated FROM tmp_replicate_cursors'
                    )
                ) {
                    return mockAllConfigs
                }
                return []
            }),
            setAlarm: vi.fn(),
            getAlarm: vi.fn().mockResolvedValue(null),
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
        mockLastRunAt = null
        mockLastCursor = null
        mockAllConfigs = []
        mockDataSource = createMockDataSource()
        vi.clearAllMocks()
    })

    describe('constructor', () => {
        it('should create plugin with correct name', () => {
            const plugin = new ReplicationPlugin()
            expect(plugin.name).toBe('starbasedb:replication')
        })

        it('should require auth', () => {
            const plugin = new ReplicationPlugin()
            expect(plugin.opts.requiresAuth).toBe(true)
        })
    })

    describe('buildFetchQuery', () => {
        it('should build query without WHERE clause when no cursor exists', () => {
            const plugin = new ReplicationPlugin()
            const { sql, params } = (plugin as any).buildFetchQuery(
                'users',
                '*',
                'id',
                null,
                0
            )
            expect(sql).toBe(
                'SELECT * FROM "users" ORDER BY "id" ASC LIMIT 1000'
            )
            expect(params).toEqual([])
        })

        it('should build query with WHERE clause when cursor value exists', () => {
            const plugin = new ReplicationPlugin()
            const { sql, params } = (plugin as any).buildFetchQuery(
                'users',
                '*',
                'id',
                '42',
                0
            )
            expect(sql).toBe(
                'SELECT * FROM "users" WHERE "id" > ? ORDER BY "id" ASC LIMIT 1000'
            )
            expect(params).toEqual(['42'])
        })

        it('should use OFFSET when no cursor column is specified', () => {
            const plugin = new ReplicationPlugin()
            const { sql, params } = (plugin as any).buildFetchQuery(
                'users',
                '*',
                null,
                null,
                500
            )
            expect(sql).toBe('SELECT * FROM "users" LIMIT 1000 OFFSET 500')
            expect(params).toEqual([])
        })
    })

    describe('GET /replicate/status', () => {
        it('should return 401 for non-admin role', async () => {
            const plugin = new ReplicationPlugin()
            const app = createTestApp(clientConfig, mockDataSource)
            await plugin.register(app)

            const response = await app.request('/replicate/status')
            expect(response.status).toBe(401)
        })

        it('should return checkpoint data for admin role', async () => {
            const mockStatus = [
                {
                    table_name: 'users',
                    cursor_column: 'id',
                    last_cursor: '10',
                    last_run_at: '2026-06-13T00:00:00Z',
                    rows_replicated: 10,
                },
            ]
            mockAllConfigs = mockStatus

            const plugin = new ReplicationPlugin({
                tables: [{ table: 'users' }],
            })
            const app = createTestApp(adminConfig, mockDataSource)
            await plugin.register(app)

            const response = await app.request('/replicate/status')
            expect(response.status).toBe(200)

            const body = (await response.json()) as any
            expect(body.result.tables).toEqual(mockStatus)
        })
    })

    describe('POST /replicate/run', () => {
        it('should return 401 for non-admin role', async () => {
            const plugin = new ReplicationPlugin()
            const app = createTestApp(clientConfig, mockDataSource)
            await plugin.register(app)

            const response = await app.request('/replicate/run', {
                method: 'POST',
            })
            expect(response.status).toBe(401)
        })

        it('should return success and run replication', async () => {
            // Mock external data
            vi.mocked(executeQuery).mockResolvedValueOnce([
                { id: 1, name: 'Alice' },
            ])

            const plugin = new ReplicationPlugin({
                tables: [{ table: 'users', cursorColumn: 'id' }],
            })
            const app = createTestApp(adminConfig, mockDataSource)
            await plugin.register(app)

            const response = await app.request('/replicate/run', {
                method: 'POST',
            })
            expect(response.status).toBe(200)

            const body = (await response.json()) as any
            expect(body.result.results[0].table).toBe('users')
            expect(body.result.results[0].rowsReplicated).toBe(1)
        })
    })

    describe('syncTable logic and Type mapping', () => {
        it('should write correct type mapping for integers, real, text and bool', async () => {
            vi.mocked(executeQuery).mockResolvedValueOnce([
                {
                    id: 1,
                    age: 25,
                    active: true,
                    name: 'Alice',
                    rate: 1.5,
                    details: { extra: 1 },
                },
            ])

            const plugin = new ReplicationPlugin({
                tables: [{ table: 'users', cursorColumn: 'id' }],
            })
            const pluginAny = plugin as any
            pluginAny.dataSource = mockDataSource
            pluginAny.config = adminConfig

            await pluginAny.replicateTable({
                table: 'users',
                cursorColumn: 'id',
            })

            // Verify the CREATE TABLE SQL contains correct types
            const createCall = rpcMock(mockDataSource).mock.calls.find((call) =>
                call[0].sql.includes('CREATE TABLE IF NOT EXISTS')
            )
            expect(createCall).toBeDefined()
            const createSql = createCall![0].sql
            expect(createSql).toContain('"id" INTEGER')
            expect(createSql).toContain('"age" INTEGER')
            expect(createSql).toContain('"active" INTEGER')
            expect(createSql).toContain('"name" TEXT')
            expect(createSql).toContain('"rate" REAL')
            expect(createSql).toContain('"details" TEXT')

            // Verify the writeRows mapping maps active = true to 1 and details to string
            const insertCall = rpcMock(mockDataSource).mock.calls.find((call) =>
                call[0].sql.includes('INSERT OR REPLACE INTO')
            )
            expect(insertCall).toBeDefined()
            expect(insertCall![0].params).toEqual([
                1,
                25,
                1,
                'Alice',
                1.5,
                '{"extra":1}',
            ])
        })
    })

    describe('Interval-based scheduling', () => {
        it('should skip table sync if elapsed time is less than interval', async () => {
            const tableConfig = {
                table: 'users',
                cursorColumn: 'id',
                interval: 60, // 60 seconds
            }

            mockLastRunAt = new Date(Date.now() - 30 * 1000).toISOString() // 30 seconds ago

            const plugin = new ReplicationPlugin({ tables: [tableConfig] })
            const pluginAny = plugin as any
            pluginAny.dataSource = mockDataSource
            pluginAny.config = adminConfig

            const results = await plugin.runReplication(false) // force = false

            expect(results[0].status).toBe('skipped')
            expect(results[0].rowsReplicated).toBe(0)
            expect(executeQuery).not.toHaveBeenCalled()
        })

        it('should perform sync if elapsed time is greater than interval', async () => {
            const tableConfig = {
                table: 'users',
                cursorColumn: 'id',
                interval: 60, // 60 seconds
            }

            mockLastRunAt = new Date(Date.now() - 90 * 1000).toISOString() // 90 seconds ago
            mockLastCursor = null

            vi.mocked(executeQuery).mockResolvedValueOnce([
                { id: 1, name: 'Alice' },
            ])

            const plugin = new ReplicationPlugin({ tables: [tableConfig] })
            const pluginAny = plugin as any
            pluginAny.dataSource = mockDataSource
            pluginAny.config = adminConfig

            const results = await plugin.runReplication(false)

            expect(results[0].status).toBe('synced')
            expect(results[0].rowsReplicated).toBe(1)
            expect(executeQuery).toHaveBeenCalled()
        })

        it('should register cron task and intercept callback on POST /cron/callback', async () => {
            const plugin = new ReplicationPlugin({
                tables: [{ table: 'users' }],
                interval: '*/5 * * * *',
            })
            const app = createTestApp(adminConfig, mockDataSource)
            await plugin.register(app)

            // Trigger the middleware by sending request to bootstrap setupAutomaticCron
            await app.request('/some-dummy-route')

            // Now verify that POST /cron/callback intercept calls runReplication
            const runSpy = vi
                .spyOn(plugin, 'runReplication')
                .mockResolvedValueOnce([])

            const cronPayload = [
                { name: 'starbasedb:replication', cron_tab: '*/5 * * * *' },
            ]
            const response = await app.request('/cron/callback', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(cronPayload),
            })

            expect(response.status).toBe(200)
            expect(runSpy).toHaveBeenCalledWith(false)
        })
    })
})
