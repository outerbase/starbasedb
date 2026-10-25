import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DataReplicationPlugin } from './index'
import { StarbaseApp, StarbaseDBConfiguration } from '../../src/handler'
import { DataSource } from '../../src/types'
import * as operationModule from '../../src/operation'

let mockDataSource: DataSource
let mockAdminConfig: StarbaseDBConfiguration
let mockClientConfig: StarbaseDBConfiguration

beforeEach(() => {
    vi.restoreAllMocks()

    mockDataSource = {
        rpc: {
            executeQuery: vi.fn().mockResolvedValue([]),
        },
        source: 'internal',
        external: {
            dialect: 'postgresql',
            host: 'localhost',
            port: 5432,
            user: 'test',
            password: 'pwd',
            database: 'testdb',
            defaultSchema: 'public',
        },
        executionContext: {
            waitUntil: vi.fn(),
            passThroughOnException: vi.fn(),
        },
    } as unknown as DataSource

    mockAdminConfig = {
        role: 'admin',
        features: { allowlist: false, rls: false, rest: true },
    }

    mockClientConfig = {
        role: 'client',
        features: { allowlist: false, rls: false, rest: true },
    }
})

describe('DataReplicationPlugin - Route Registration and Initialization', () => {
    it('should register middleware and all admin routes on app', async () => {
        const plugin = new DataReplicationPlugin({
            config: { tables: [] },
        })

        const registeredRoutes: { method: string; path: string }[] = []
        const mockApp = {
            use: vi.fn(),
            get: vi.fn((path: string) =>
                registeredRoutes.push({ method: 'GET', path })
            ),
            post: vi.fn((path: string) =>
                registeredRoutes.push({ method: 'POST', path })
            ),
            delete: vi.fn((path: string) =>
                registeredRoutes.push({ method: 'DELETE', path })
            ),
        } as unknown as StarbaseApp

        await plugin.register(mockApp)

        expect(mockApp.use).toHaveBeenCalled()
        expect(registeredRoutes).toContainEqual({
            method: 'GET',
            path: '/replication/status',
        })
        expect(registeredRoutes).toContainEqual({
            method: 'GET',
            path: '/replication/status/:table',
        })
        expect(registeredRoutes).toContainEqual({
            method: 'POST',
            path: '/replication/sync',
        })
        expect(registeredRoutes).toContainEqual({
            method: 'POST',
            path: '/replication/sync/:table',
        })
        expect(registeredRoutes).toContainEqual({
            method: 'DELETE',
            path: '/replication/state/:table',
        })
        expect(registeredRoutes).toContainEqual({
            method: 'GET',
            path: '/replication/history',
        })
        expect(registeredRoutes).toContainEqual({
            method: 'GET',
            path: '/replication/history/:table',
        })
    })

    it('should create tmp_replication_state and tmp_replication_history tables on init', async () => {
        const plugin = new DataReplicationPlugin({
            config: { tables: [] },
        })

        let middlewareFn: (
            context: unknown,
            next: () => Promise<void>
        ) => Promise<void>
        const mockApp = {
            use: vi.fn((fn) => {
                middlewareFn = fn
            }),
            get: vi.fn(),
            post: vi.fn(),
            delete: vi.fn(),
        } as unknown as StarbaseApp

        await plugin.register(mockApp)

        const mockContext = {
            get: vi.fn((key: string) => {
                if (key === 'dataSource') return mockDataSource
                if (key === 'config') return mockAdminConfig
                return undefined
            }),
        }

        await middlewareFn(mockContext, vi.fn())

        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledWith(
            expect.objectContaining({
                sql: expect.stringContaining(
                    'CREATE TABLE IF NOT EXISTS tmp_replication_state'
                ),
            })
        )
        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledWith(
            expect.objectContaining({
                sql: expect.stringContaining(
                    'CREATE TABLE IF NOT EXISTS tmp_replication_history'
                ),
            })
        )
    })
})

describe('DataReplicationPlugin - Admin Authorization', () => {
    async function setupPluginWithRole(role: 'admin' | 'client') {
        const plugin = new DataReplicationPlugin({
            config: {
                tables: [
                    {
                        sourceTable: 'users',
                        schema: 'public',
                        cursorColumn: 'id',
                        cursorType: 'integer',
                    },
                ],
            },
        })

        const handlers: Record<
            string,
            (context: unknown) => Promise<Response>
        > = {}
        let middlewareFn: (
            context: unknown,
            next: () => Promise<void>
        ) => Promise<void>
        const mockApp = {
            use: vi.fn((fn) => {
                middlewareFn = fn
            }),
            get: vi.fn((path, handler) => {
                handlers[`GET ${path}`] = handler
            }),
            post: vi.fn((path, handler) => {
                handlers[`POST ${path}`] = handler
            }),
            delete: vi.fn((path, handler) => {
                handlers[`DELETE ${path}`] = handler
            }),
        } as unknown as StarbaseApp

        await plugin.register(mockApp)

        const mockContext = {
            get: vi.fn((key: string) => {
                if (key === 'dataSource') return mockDataSource
                if (key === 'config')
                    return role === 'admin' ? mockAdminConfig : mockClientConfig
                return undefined
            }),
            req: {
                param: vi.fn((paramName: string) =>
                    paramName === 'table' ? 'users' : ''
                ),
            },
        }

        await middlewareFn(mockContext, vi.fn())
        return { plugin, handlers, mockContext }
    }

    it('should reject non-admin users with 401 on all endpoints', async () => {
        const { handlers, mockContext } = await setupPluginWithRole('client')

        const routes = [
            'GET /replication/status',
            'GET /replication/status/:table',
            'POST /replication/sync',
            'POST /replication/sync/:table',
            'DELETE /replication/state/:table',
            'GET /replication/history',
            'GET /replication/history/:table',
        ]

        for (const route of routes) {
            const handler = handlers[route]
            expect(handler).toBeDefined()
            const res = await handler(mockContext)
            expect(res.status).toBe(401)
        }
    })

    it('should allow admin users on status, history and state endpoints', async () => {
        const { handlers, mockContext } = await setupPluginWithRole('admin')

        vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValue([
            {
                source_table: 'users',
                target_table: 'public_users',
                status: 'idle',
            } as unknown as Record<string, unknown>,
        ])

        const statusRes = await handlers['GET /replication/status'](mockContext)
        expect(statusRes.status).toBe(200)

        const tableStatusRes =
            await handlers['GET /replication/status/:table'](mockContext)
        expect(tableStatusRes.status).toBe(200)

        const deleteStateRes =
            await handlers['DELETE /replication/state/:table'](mockContext)
        expect(deleteStateRes.status).toBe(200)

        const historyRes =
            await handlers['GET /replication/history'](mockContext)
        expect(historyRes.status).toBe(200)
    })
})

describe('DataReplicationPlugin - beforeQuery Table Resolution', () => {
    it('should rewrite public.users to public_users for SQLite compatibility', async () => {
        const plugin = new DataReplicationPlugin({
            config: {
                tables: [
                    {
                        sourceTable: 'users',
                        schema: 'public',
                        cursorColumn: 'id',
                    },
                    {
                        sourceTable: 'orders',
                        schema: 'public',
                        cursorColumn: 'id',
                        targetTable: 'my_edge_orders',
                    },
                ],
            },
        })

        const query1 = await plugin.beforeQuery({
            sql: 'SELECT * FROM public.users WHERE id = 1',
            params: [],
            isRaw: false,
        })
        expect(query1.sql).toBe('SELECT * FROM "public_users" WHERE id = 1')

        const query2 = await plugin.beforeQuery({
            sql: 'SELECT * FROM "public"."users" JOIN public.orders ON public.users.id = public.orders.user_id',
            params: [],
            isRaw: false,
        })
        expect(query2.sql).toContain('"public_users"')
        expect(query2.sql).toContain('"my_edge_orders"')

        const query3 = await plugin.beforeQuery({
            sql: 'SELECT * FROM `public`.`users`',
            params: [],
            isRaw: false,
        })
        expect(query3.sql).toBe('SELECT * FROM "public_users"')
    })

    it('should leave unrelated queries unchanged', async () => {
        const plugin = new DataReplicationPlugin({
            config: {
                tables: [
                    {
                        sourceTable: 'users',
                        schema: 'public',
                        cursorColumn: 'id',
                    },
                ],
            },
        })

        const query = await plugin.beforeQuery({
            sql: 'SELECT * FROM local_cache WHERE key = ?',
            params: ['token'],
            isRaw: false,
        })
        expect(query.sql).toBe('SELECT * FROM local_cache WHERE key = ?')
        expect(query.params).toEqual(['token'])
    })
})

describe('DataReplicationPlugin - Replication Execution Logic', () => {
    it('should introspect external schema and create SQLite table on initial sync', async () => {
        const plugin = new DataReplicationPlugin({
            config: {
                tables: [
                    {
                        sourceTable: 'customers',
                        schema: 'public',
                        cursorColumn: 'id',
                        cursorType: 'integer',
                    },
                ],
            },
        })

        // Mock introspect query returning columns
        vi.spyOn(operationModule, 'executeExternalQuery')
            .mockResolvedValueOnce([
                { column_name: 'id', data_type: 'integer', is_nullable: 'NO' },
                {
                    column_name: 'email',
                    data_type: 'varchar',
                    is_nullable: 'NO',
                },
                {
                    column_name: 'balance',
                    data_type: 'numeric',
                    is_nullable: 'YES',
                },
            ])
            // Fetch query returning 2 rows
            .mockResolvedValueOnce([
                { id: 1, email: 'alice@example.com', balance: 100.5 },
                { id: 2, email: 'bob@example.com', balance: 250.0 },
            ])

        const results = await plugin.syncAll(mockDataSource, mockAdminConfig)

        expect(results).toHaveLength(1)
        expect(results[0].success).toBe(true)
        expect(results[0].rowsSynced).toBe(2)
        expect(results[0].targetTable).toBe('public_customers')

        // Verify CREATE TABLE IF NOT EXISTS was executed on SQLite
        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledWith(
            expect.objectContaining({
                sql: expect.stringMatching(
                    /CREATE TABLE IF NOT EXISTS "public_customers"/
                ),
            })
        )

        // Verify rows were inserted via INSERT OR REPLACE
        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledWith(
            expect.objectContaining({
                sql: expect.stringMatching(
                    /INSERT OR REPLACE INTO "public_customers"/
                ),
                params: [1, 'alice@example.com', 100.5],
            })
        )

        // Verify tmp_replication_history audit record was written
        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledWith(
            expect.objectContaining({
                sql: expect.stringContaining(
                    'INSERT INTO tmp_replication_history'
                ),
                params: expect.arrayContaining([
                    'customers',
                    'public_customers',
                    2,
                    expect.any(Number),
                    'success',
                ]),
            })
        )
    })

    it('should perform incremental sync using cursor value when state already exists', async () => {
        const plugin = new DataReplicationPlugin({
            config: {
                tables: [
                    {
                        sourceTable: 'events',
                        schema: 'public',
                        cursorColumn: 'id',
                        cursorType: 'integer',
                    },
                ],
            },
        })

        // Mock getState returning existing checkpoint cursor at '100'
        vi.mocked(mockDataSource.rpc.executeQuery).mockImplementation(
            async (opts: { sql: string; params?: unknown[] }) => {
                if (
                    opts.sql.includes(
                        'SELECT source_table, target_table, last_cursor_value'
                    )
                ) {
                    return [
                        {
                            source_table: 'events',
                            target_table: 'public_events',
                            last_cursor_value: '100',
                            rows_synced: 100,
                            total_rows_synced: 100,
                            status: 'success',
                            error_message: null,
                        },
                    ] as unknown as Record<string, unknown>[]
                }
                return [] as unknown as Record<string, unknown>[]
            }
        )

        const executeExternalSpy = vi
            .spyOn(operationModule, 'executeExternalQuery')
            .mockResolvedValueOnce([
                { id: 101, event_type: 'login' },
                { id: 102, event_type: 'click' },
            ])

        const results = await plugin.syncAll(mockDataSource, mockAdminConfig)

        expect(results[0].success).toBe(true)
        expect(results[0].rowsSynced).toBe(2)

        // Verify fetch query passed cursorValue '100'
        expect(executeExternalSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                sql: expect.stringContaining('WHERE "id" > ?'),
                params: ['100', 1000],
            })
        )

        // Verify cursor advanced to '102'
        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledWith(
            expect.objectContaining({
                sql: expect.stringContaining(
                    'INSERT INTO tmp_replication_state'
                ),
                params: expect.arrayContaining([
                    'events',
                    'public_events',
                    '102',
                ]),
            })
        )
    })

    it('should isolate errors so one failing table does not block others', async () => {
        const plugin = new DataReplicationPlugin({
            config: {
                tables: [
                    {
                        sourceTable: 'failing_table',
                        cursorColumn: 'id',
                    },
                    {
                        sourceTable: 'healthy_table',
                        cursorColumn: 'id',
                    },
                ],
            },
        })

        vi.spyOn(operationModule, 'executeExternalQuery').mockImplementation(
            async (opts: { sql: string }) => {
                if (opts.sql.includes('failing_table')) {
                    throw new Error('Connection timeout to external shard')
                }
                if (opts.sql.includes('information_schema')) {
                    return [
                        {
                            column_name: 'id',
                            data_type: 'integer',
                            is_nullable: 'NO',
                        },
                    ]
                }
                return [{ id: 1 }]
            }
        )

        const results = await plugin.syncAll(mockDataSource, mockAdminConfig)

        expect(results).toHaveLength(2)
        expect(results[0].table).toBe('failing_table')
        expect(results[0].success).toBe(false)
        expect(results[0].error).toContain(
            'Connection timeout to external shard'
        )

        expect(results[1].table).toBe('healthy_table')
        expect(results[1].success).toBe(true)
        expect(results[1].rowsSynced).toBe(1)

        // Verify failure was logged to tmp_replication_history
        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledWith(
            expect.objectContaining({
                sql: expect.stringContaining(
                    'INSERT INTO tmp_replication_history'
                ),
                params: expect.arrayContaining([
                    'failing_table',
                    'public_failing_table',
                    0,
                    expect.any(Number),
                    'error',
                    'Connection timeout to external shard',
                ]),
            })
        )
    })

    it('should correctly serialize JSON and nested objects into SQLite TEXT', async () => {
        const plugin = new DataReplicationPlugin({
            config: {
                tables: [
                    {
                        sourceTable: 'configs',
                        schema: 'public',
                        cursorColumn: 'id',
                    },
                ],
            },
        })

        vi.spyOn(operationModule, 'executeExternalQuery')
            .mockResolvedValueOnce([
                { column_name: 'id', data_type: 'integer', is_nullable: 'NO' },
                {
                    column_name: 'payload',
                    data_type: 'jsonb',
                    is_nullable: 'YES',
                },
            ])
            .mockResolvedValueOnce([
                { id: 1, payload: { theme: 'dark', notifications: true } },
            ])

        await plugin.syncAll(mockDataSource, mockAdminConfig)

        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledWith(
            expect.objectContaining({
                sql: expect.stringMatching(
                    /INSERT OR REPLACE INTO "public_configs"/
                ),
                params: [
                    1,
                    JSON.stringify({ theme: 'dark', notifications: true }),
                ],
            })
        )
    })
})
