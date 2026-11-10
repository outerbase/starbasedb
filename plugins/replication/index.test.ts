import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { ReplicationPlugin, TableReplicationConfig } from './index'
import type { DataSource } from '../../src/types'
import type { StarbaseApp } from '../../src/handler'

describe('ReplicationPlugin', () => {
    let mockDataSource: DataSource
    let executedRpcQueries: { sql: string; params?: unknown[] }[]
    let executedExternalQueries: { sql: string; params?: unknown[] }[]
    let externalMockData: Record<string, any>[]
    let stateMockTable: Record<string, any>[]

    beforeEach(() => {
        vi.clearAllMocks()
        executedRpcQueries = []
        executedExternalQueries = []
        externalMockData = []
        stateMockTable = []

        mockDataSource = {
            source: 'external',
            external: {
                dialect: 'postgres',
                executeQuery: vi.fn(
                    async ({
                        sql,
                        params,
                    }: {
                        sql: string
                        params?: unknown[]
                    }) => {
                        executedExternalQueries.push({ sql, params })
                        return externalMockData
                    }
                ),
            } as any,
            rpc: {
                executeQuery: vi.fn(
                    async ({
                        sql,
                        params,
                    }: {
                        sql: string
                        params?: unknown[]
                    }) => {
                        executedRpcQueries.push({ sql, params })

                        if (
                            sql.includes('SELECT') &&
                            sql.includes('_starbase_replication_state')
                        ) {
                            if (sql.includes('WHERE table_name = ?')) {
                                const tableName = params?.[0]
                                const found = stateMockTable.filter(
                                    (r) => r.table_name === tableName
                                )
                                return found
                            }
                            return stateMockTable
                        }

                        if (
                            sql.includes(
                                'INSERT OR REPLACE INTO _starbase_replication_state'
                            )
                        ) {
                            const [
                                table_name,
                                cursor_value,
                                last_sync_at,
                                total_rows_synced,
                                status,
                                last_error,
                            ] = (params ?? []) as any[]
                            const idx = stateMockTable.findIndex(
                                (r) => r.table_name === table_name
                            )
                            const record = {
                                table_name,
                                cursor_value,
                                last_sync_at,
                                total_rows_synced,
                                status,
                                last_error,
                            }
                            if (idx >= 0) {
                                stateMockTable[idx] = record
                            } else {
                                stateMockTable.push(record)
                            }
                            return []
                        }

                        if (
                            sql.includes('UPDATE _starbase_replication_state')
                        ) {
                            if (sql.includes('WHERE table_name = ?')) {
                                const tableName = params?.[0]
                                const row = stateMockTable.find(
                                    (r) => r.table_name === tableName
                                )
                                if (row) {
                                    row.cursor_value = null
                                    row.last_sync_at = null
                                    row.total_rows_synced = 0
                                    row.status = 'idle'
                                    row.last_error = null
                                }
                            } else {
                                stateMockTable.forEach((row) => {
                                    row.cursor_value = null
                                    row.last_sync_at = null
                                    row.total_rows_synced = 0
                                    row.status = 'idle'
                                    row.last_error = null
                                })
                            }
                            return []
                        }

                        return []
                    }
                ),
            },
        } as any
    })

    describe('Initialization & Configuration', () => {
        it('should initialize with default options', () => {
            const plugin = new ReplicationPlugin()
            expect(plugin.name).toBe('starbasedb:replication')
            expect(plugin.prefix).toBe('/replication')
            expect(plugin.pathPrefix).toBe('/replication')
            expect(plugin.getTableConfigs()).toEqual([])
        })

        it('should initialize with pre-configured tables', () => {
            const plugin = new ReplicationPlugin({
                tables: [
                    { name: 'users', cursorColumn: 'id' },
                    { name: 'orders', primaryKey: 'order_id', batchSize: 250 },
                ],
                defaultIntervalSeconds: 120,
            })

            const configs = plugin.getTableConfigs()
            expect(configs).toHaveLength(2)
            expect(configs[0].name).toBe('users')
            expect(configs[0].targetTable).toBe('users')
            expect(configs[0].batchSize).toBe(500)
            expect(configs[0].syncIntervalSeconds).toBe(120)

            expect(configs[1].name).toBe('orders')
            expect(configs[1].primaryKey).toBe('order_id')
            expect(configs[1].batchSize).toBe(250)
        })

        it('should strip schema prefix for default targetTable', () => {
            const plugin = new ReplicationPlugin()
            plugin.configureTable({ name: 'public.customers' })

            const config = plugin.getTableConfig('public.customers')
            expect(config).toBeDefined()
            expect(config?.targetTable).toBe('customers')
        })

        it('should throw an error when configuring a table without a valid name', () => {
            const plugin = new ReplicationPlugin()
            expect(() => plugin.configureTable({ name: '' })).toThrow(
                'Table name is required for replication configuration'
            )
            expect(() => plugin.configureTable({ name: '   ' })).toThrow(
                'Table name is required for replication configuration'
            )
        })

        it('should initialize schema state table in init()', async () => {
            const plugin = new ReplicationPlugin()
            plugin.setDataSource(mockDataSource)
            await plugin.init()

            expect(executedRpcQueries).toHaveLength(1)
            expect(executedRpcQueries[0].sql).toContain(
                'CREATE TABLE IF NOT EXISTS _starbase_replication_state'
            )
        })
    })

    describe('HTTP Routes & Hono Middleware', () => {
        let app: StarbaseApp
        let plugin: ReplicationPlugin

        beforeEach(async () => {
            app = new Hono() as unknown as StarbaseApp
            app.use('*', async (c, next) => {
                c.set('dataSource', mockDataSource)
                await next()
            })

            plugin = new ReplicationPlugin({
                tables: [{ name: 'products', cursorColumn: 'id' }],
            })
            await plugin.register(app)
        })

        it('GET /replication/status returns replication status', async () => {
            const res = await app.request('/replication/status', {
                method: 'GET',
            })
            expect(res.status).toBe(200)

            const body = await res.json()
            expect(body.error).toBeUndefined()
            expect(body.result.configuredCount).toBe(1)
            expect(body.result.syncingTables).toEqual([])
            expect(Array.isArray(body.result.tables)).toBe(true)
        })

        it('POST /replication/configure dynamically adds table config', async () => {
            const res = await app.request('/replication/configure', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: 'invoices',
                    cursorColumn: 'created_at',
                    batchSize: 100,
                }),
            })
            expect(res.status).toBe(200)
            const body = await res.json()
            expect(body.result.success).toBe(true)
            expect(body.result.table).toBe('invoices')
            expect(plugin.getTableConfigs()).toHaveLength(2)
        })

        it('POST /replication/configure returns 400 when name is invalid', async () => {
            const res = await app.request('/replication/configure', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: '' }),
            })
            expect(res.status).toBe(400)
            const body = await res.json()
            expect(body.error).toBe(
                'Table name is required for replication configuration'
            )
        })

        it('POST /replication/reset resets single table or all tables', async () => {
            stateMockTable.push({
                table_name: 'products',
                cursor_value: '100',
                last_sync_at: Date.now(),
                total_rows_synced: 50,
                status: 'synced',
                last_error: null,
            })

            const res = await app.request('/replication/reset', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ table: 'products' }),
            })
            expect(res.status).toBe(200)
            const row = stateMockTable.find((r) => r.table_name === 'products')
            expect(row?.cursor_value).toBeNull()
            expect(row?.total_rows_synced).toBe(0)
            expect(row?.status).toBe('idle')
        })

        it('POST /replication/sync triggers table sync', async () => {
            externalMockData = [
                { id: 1, name: 'Widget A', price: 9.99 },
                { id: 2, name: 'Widget B', price: 19.99 },
            ]

            const res = await app.request('/replication/sync', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ table: 'products' }),
            })
            expect(res.status).toBe(200)
            const body = await res.json()
            expect(body.result.table).toBe('products')
            expect(body.result.rowsSynced).toBe(2)
            expect(body.result.newCursor).toBe('2')
        })
    })

    describe('Replication Sync Execution', () => {
        let plugin: ReplicationPlugin

        beforeEach(() => {
            plugin = new ReplicationPlugin({
                tables: [
                    {
                        name: 'public.users',
                        targetTable: 'users',
                        cursorColumn: 'id',
                        primaryKey: 'id',
                        whereClause: 'active = 1',
                        batchSize: 10,
                    },
                ],
            })
            plugin.setDataSource(mockDataSource)
        })

        it('should handle zero rows returned from external source gracefully', async () => {
            externalMockData = []
            const result = await plugin.syncTable('public.users')

            expect(result.table).toBe('public.users')
            expect(result.rowsSynced).toBe(0)
            expect(result.newCursor).toBeNull()

            const state = stateMockTable.find(
                (r) => r.table_name === 'public.users'
            )
            expect(state?.status).toBe('synced')
            expect(state?.total_rows_synced).toBe(0)
        })

        it('should auto-create local SQLite table with correct types and primary key', async () => {
            externalMockData = [
                { id: 1, username: 'alice', is_admin: 1, balance: 125.5 },
            ]

            await plugin.syncTable('public.users')

            const createTableQuery = executedRpcQueries.find((q) =>
                q.sql.includes('CREATE TABLE IF NOT EXISTS "users"')
            )
            expect(createTableQuery).toBeDefined()
            expect(createTableQuery?.sql).toContain('"id" INTEGER PRIMARY KEY')
            expect(createTableQuery?.sql).toContain('"username" TEXT')
            expect(createTableQuery?.sql).toContain('"balance" REAL')
        })

        it('should perform incremental sync using cursorColumn', async () => {
            // First batch: rows 1 and 2
            externalMockData = [
                { id: 1, name: 'Alice' },
                { id: 2, name: 'Bob' },
            ]

            const firstResult = await plugin.syncTable('public.users')
            expect(firstResult.rowsSynced).toBe(2)
            expect(firstResult.newCursor).toBe('2')

            const stateAfterFirst = stateMockTable.find(
                (r) => r.table_name === 'public.users'
            )
            expect(stateAfterFirst?.cursor_value).toBe('2')
            expect(stateAfterFirst?.total_rows_synced).toBe(2)

            // Second batch: rows 3 and 4
            externalMockData = [
                { id: 3, name: 'Charlie' },
                { id: 4, name: 'Diana' },
            ]

            const secondResult = await plugin.syncTable('public.users')
            expect(secondResult.rowsSynced).toBe(2)
            expect(secondResult.newCursor).toBe('4')

            // Verify query in second run included cursor condition
            const lastExtQuery =
                executedExternalQueries[executedExternalQueries.length - 1]
            expect(lastExtQuery.sql).toContain('"id" > ?')
            expect(lastExtQuery.params).toContain('2')

            const stateAfterSecond = stateMockTable.find(
                (r) => r.table_name === 'public.users'
            )
            expect(stateAfterSecond?.cursor_value).toBe('4')
            expect(stateAfterSecond?.total_rows_synced).toBe(4)
        })

        it('should support forceFull = true to bypass existing cursor', async () => {
            stateMockTable.push({
                table_name: 'public.users',
                cursor_value: '50',
                last_sync_at: Date.now(),
                total_rows_synced: 50,
                status: 'synced',
                last_error: null,
            })

            externalMockData = [{ id: 1, name: 'Root' }]

            const result = await plugin.syncTable('public.users', true)
            expect(result.rowsSynced).toBe(1)
            expect(result.newCursor).toBe('1')

            const lastExtQuery =
                executedExternalQueries[executedExternalQueries.length - 1]
            expect(lastExtQuery.sql).not.toContain('"id" > ?')
        })

        it('should prevent concurrent sync on the same table with lock guard', async () => {
            let resolveExternalQuery: (value: any) => void
            const delayPromise = new Promise((resolve) => {
                resolveExternalQuery = resolve
            })

            mockDataSource.external!.executeQuery = vi
                .fn()
                .mockImplementation(async () => {
                    await delayPromise
                    return [{ id: 10, name: 'Pending' }]
                })

            const firstSyncPromise = plugin.syncTable('public.users')
            const secondSyncResult = await plugin.syncTable('public.users')

            expect(secondSyncResult.error).toContain('is already in progress')
            expect(secondSyncResult.rowsSynced).toBe(0)

            resolveExternalQuery!([{ id: 10, name: 'Pending' }])
            const firstSyncResult = await firstSyncPromise
            expect(firstSyncResult.rowsSynced).toBe(1)
        })

        it('should record error state in SQLite when external source fails', async () => {
            mockDataSource.external!.executeQuery = vi
                .fn()
                .mockRejectedValue(new Error('Connection timeout to Supabase'))

            const result = await plugin.syncTable('public.users')
            expect(result.rowsSynced).toBe(0)
            expect(result.error).toBe('Connection timeout to Supabase')

            const state = stateMockTable.find(
                (r) => r.table_name === 'public.users'
            )
            expect(state?.status).toBe('error')
            expect(state?.last_error).toContain(
                'Connection timeout to Supabase'
            )
        })

        it('should sync all configured tables with syncAll() and handleCron()', async () => {
            plugin.configureTable({ name: 'orders', cursorColumn: 'id' })
            externalMockData = [{ id: 100 }]

            const results = await plugin.syncAll()
            expect(results).toHaveLength(2)

            const cronResults = await plugin.handleCron()
            expect(cronResults).toHaveLength(2)
        })
    })
})
