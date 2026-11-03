import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
    DataSyncPlugin,
    ReplicationPlugin,
    PostgresSyncSource,
    MySQLSyncSource,
    normalizeExternalRows,
    serializeSqliteValue,
    quoteSqlIdentifier,
} from './index'
import { executeExternalQuery } from '../../src/operation'
import type { StarbaseApp, StarbaseDBConfiguration } from '../../src/handler'
import type { DataSource } from '../../src/types'

vi.mock('../../src/operation', () => ({
    executeExternalQuery: vi.fn(),
}))

describe('DataSyncPlugin / ReplicationPlugin (#72)', () => {
    let mockDataSource: DataSource
    let mockConfig: StarbaseDBConfiguration
    let executedInternalQueries: Array<{ sql: string; params?: any[] }>

    beforeEach(() => {
        vi.clearAllMocks()
        executedInternalQueries = []

        mockDataSource = {
            source: 'internal',
            external: {
                dialect: 'postgresql',
                host: 'localhost',
                port: 5432,
                user: 'postgres',
                password: 'password',
                database: 'postgres',
            },
            rpc: {
                executeQuery: vi.fn(
                    async (opts: { sql: string; params?: any[] }) => {
                        executedInternalQueries.push(opts)
                        if (
                            opts.sql.includes(
                                'FROM tmp_data_sync_metadata\n        WHERE table_name = ?'
                            )
                        ) {
                            return []
                        }
                        if (opts.sql.includes('FROM tmp_data_sync_metadata')) {
                            return [
                                {
                                    table_name: 'users',
                                    source_schema: 'public',
                                    source_table: 'users',
                                    tracking_column: 'updated_at',
                                    last_sync_timestamp: 1700000000000,
                                    last_sync_value: '2025-01-01T00:00:00Z',
                                    rows_synced: 2,
                                    status: 'synced',
                                    last_error: null,
                                },
                            ]
                        }
                        if (opts.sql.includes('FROM tmp_data_sync_errors')) {
                            return []
                        }
                        if (opts.sql.startsWith('PRAGMA table_info')) {
                            return []
                        }
                        return []
                    }
                ),
            },
        } as unknown as DataSource

        mockConfig = {
            role: 'admin',
            outerbaseApiKey: 'mock-key',
        }
    })

    describe('PostgresSyncSource & MySQLSyncSource Adapters', () => {
        it('maps PostgreSQL and MySQL column types to SQLite affinities accurately', () => {
            const pg = new PostgresSyncSource({ dialect: 'postgresql' })
            expect(pg.mapColumnType('integer')).toBe('INTEGER')
            expect(pg.mapColumnType('bigint')).toBe('INTEGER')
            expect(pg.mapColumnType('boolean')).toBe('INTEGER')
            expect(pg.mapColumnType('numeric')).toBe('REAL')
            expect(pg.mapColumnType('double precision')).toBe('REAL')
            expect(pg.mapColumnType('bytea')).toBe('BLOB')
            expect(pg.mapColumnType('character varying')).toBe('TEXT')
            expect(pg.mapColumnType('timestamp with time zone')).toBe('TEXT')

            const mysql = new MySQLSyncSource({ dialect: 'mysql' })
            expect(mysql.mapColumnType('tinyint')).toBe('INTEGER')
            expect(mysql.mapColumnType('decimal')).toBe('REAL')
            expect(mysql.mapColumnType('longblob')).toBe('BLOB')
            expect(mysql.mapColumnType('varchar')).toBe('TEXT')
        })

        it('resolves public and custom schema table names without dots', () => {
            const pg = new PostgresSyncSource()
            expect(pg.parseTableIdentifier('users')).toEqual({
                sourceSchema: 'public',
                sourceTable: 'users',
                internalTable: 'users',
            })
            expect(pg.parseTableIdentifier('public.users')).toEqual({
                sourceSchema: 'public',
                sourceTable: 'users',
                internalTable: 'users',
            })
            expect(pg.parseTableIdentifier('analytics.events')).toEqual({
                sourceSchema: 'analytics',
                sourceTable: 'events',
                internalTable: 'analytics_events',
            })
        })

        it('builds incremental and full fetch queries for both Postgres and MySQL', () => {
            const pg = new PostgresSyncSource()
            expect(
                pg.getFetchRecordsQuery({
                    schema: 'public',
                    table: 'users',
                    trackingColumn: 'id',
                    lastValue: 10,
                    batchSize: 100,
                    offset: 0,
                }).sql
            ).toBe(
                'SELECT * FROM users WHERE id > 10 ORDER BY id ASC LIMIT 100 OFFSET 0'
            )

            const mysql = new MySQLSyncSource()
            expect(
                mysql.getFetchRecordsQuery({
                    schema: 'analytics',
                    table: 'events',
                    trackingColumn: 'created_at',
                    lastValue: '2025-01-01',
                    batchSize: 50,
                    offset: 0,
                }).sql
            ).toBe(
                "SELECT * FROM analytics.events WHERE created_at > '2025-01-01' ORDER BY created_at ASC LIMIT 50 OFFSET 0"
            )
        })
    })

    describe('DataSyncPlugin Replication Lifecycle', () => {
        it('replicates multiple tables from Postgres into internal SQLite with tmp_ metadata tables', async () => {
            const syncStore = new PostgresSyncSource({ dialect: 'postgresql' })
            const plugin = new DataSyncPlugin(syncStore, {
                sync_interval: 60,
                tables: ['users', 'person'],
            })
            plugin['dataSource'] = mockDataSource
            plugin['config'] = mockConfig

            vi.mocked(executeExternalQuery)
                // 1. users schema
                .mockResolvedValueOnce([
                    {
                        column_name: 'id',
                        data_type: 'integer',
                        is_nullable: 'NO',
                        is_primary_key: 1,
                    },
                    {
                        column_name: 'name',
                        data_type: 'text',
                        is_nullable: 'YES',
                        is_primary_key: 0,
                    },
                    {
                        column_name: 'updated_at',
                        data_type: 'timestamp',
                        is_nullable: 'YES',
                        is_primary_key: 0,
                    },
                ])
                // 2. users rows
                .mockResolvedValueOnce([
                    {
                        id: 1,
                        name: 'Alice',
                        updated_at: '2025-01-01T10:00:00Z',
                    },
                    {
                        id: 2,
                        name: 'Bob',
                        updated_at: '2025-01-01T11:00:00Z',
                    },
                ])
                // 3. person schema
                .mockResolvedValueOnce([
                    {
                        column_name: 'person_id',
                        data_type: 'integer',
                        is_nullable: 'NO',
                        is_primary_key: 1,
                    },
                    {
                        column_name: 'email',
                        data_type: 'varchar',
                        is_nullable: 'NO',
                        is_primary_key: 0,
                    },
                ])
                // 4. person rows
                .mockResolvedValueOnce([
                    { person_id: 101, email: 'alice@example.com' },
                ])

            const results = await plugin.syncAllTables()

            expect(results).toEqual([
                { table: 'users', rowsSynced: 2, status: 'synced' },
                { table: 'person', rowsSynced: 1, status: 'synced' },
            ])

            const sqlStatements = executedInternalQueries.map((q) => q.sql)

            // Verify tmp_ prefix on internal metadata and error tables
            expect(
                sqlStatements.some((s) =>
                    s.includes(
                        'CREATE TABLE IF NOT EXISTS tmp_data_sync_metadata'
                    )
                )
            ).toBe(true)
            expect(
                sqlStatements.some((s) =>
                    s.includes(
                        'CREATE TABLE IF NOT EXISTS tmp_data_sync_errors'
                    )
                )
            ).toBe(true)

            // Verify internal tables are named `users` and `person` (not `users.table`)
            expect(
                sqlStatements.some((s) =>
                    s.includes(
                        'CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT, updated_at TEXT)'
                    )
                )
            ).toBe(true)
            expect(
                sqlStatements.some((s) =>
                    s.includes(
                        'CREATE TABLE IF NOT EXISTS person (person_id INTEGER PRIMARY KEY, email TEXT NOT NULL)'
                    )
                )
            ).toBe(true)

            // Verify upserts
            expect(
                sqlStatements.some((s) =>
                    s.includes(
                        'INSERT OR REPLACE INTO users (id, name, updated_at) VALUES (?, ?, ?)'
                    )
                )
            ).toBe(true)
            expect(
                sqlStatements.some((s) =>
                    s.includes(
                        'INSERT OR REPLACE INTO person (person_id, email) VALUES (?, ?)'
                    )
                )
            ).toBe(true)
        })

        it('supports custom trackingColumn and schema expansion when new columns appear', async () => {
            const plugin = new ReplicationPlugin({
                sync_interval: 120,
                tables: [
                    {
                        table: 'events',
                        schema: 'analytics',
                        trackingColumn: 'seq_num',
                        primaryKey: 'event_uuid',
                        batchSize: 2,
                    },
                ],
            })
            plugin['dataSource'] = mockDataSource
            plugin['config'] = mockConfig

            // Simulate existing table missing the `payload` column in PRAGMA table_info
            vi.mocked(mockDataSource.rpc.executeQuery).mockImplementation(
                async (opts: { sql: string; params?: any[] }) => {
                    executedInternalQueries.push(opts)
                    if (opts.sql.startsWith('PRAGMA table_info')) {
                        return [{ name: 'event_uuid' }, { name: 'seq_num' }]
                    }
                    return []
                }
            )

            vi.mocked(executeExternalQuery)
                .mockResolvedValueOnce([
                    {
                        column_name: 'event_uuid',
                        data_type: 'uuid',
                        is_nullable: 'NO',
                        is_primary_key: 0,
                    },
                    {
                        column_name: 'seq_num',
                        data_type: 'bigint',
                        is_nullable: 'NO',
                        is_primary_key: 0,
                    },
                    {
                        column_name: 'payload',
                        data_type: 'jsonb',
                        is_nullable: 'YES',
                        is_primary_key: 0,
                    },
                ])
                // Batch 1 (full batch of 2)
                .mockResolvedValueOnce([
                    {
                        event_uuid: 'e1',
                        seq_num: 100,
                        payload: { action: 'login' },
                    },
                    {
                        event_uuid: 'e2',
                        seq_num: 101,
                        payload: { action: 'view' },
                    },
                ])
                // Batch 2 (1 row -> end)
                .mockResolvedValueOnce([
                    {
                        event_uuid: 'e3',
                        seq_num: 102,
                        payload: { action: 'logout' },
                    },
                ])

            const results = await plugin.syncAllTables()
            expect(results).toEqual([
                { table: 'analytics_events', rowsSynced: 3, status: 'synced' },
            ])

            // Verify ALTER TABLE added the missing `payload` column
            expect(
                executedInternalQueries.some(
                    (q) =>
                        q.sql ===
                        'ALTER TABLE analytics_events ADD COLUMN payload TEXT'
                )
            ).toBe(true)

            // Verify second batch used checkpoint `seq_num > '101'`
            expect(executeExternalQuery).toHaveBeenNthCalledWith(
                3,
                expect.objectContaining({
                    sql: "SELECT * FROM analytics.events WHERE seq_num > '101' ORDER BY seq_num ASC LIMIT 2 OFFSET 0",
                })
            )
        })

        it('rewrites public.<table> and <schema>.<table> in beforeQuery for internal queries', async () => {
            const plugin = new DataSyncPlugin({
                tables: ['public.users', 'analytics.events'],
            })

            const q1 = await plugin.beforeQuery({
                sql: 'SELECT * FROM public.users WHERE id = 1',
                params: [],
                dataSource: { source: 'internal' } as DataSource,
            })
            expect(q1.sql).toBe('SELECT * FROM users WHERE id = 1')

            const q2 = await plugin.beforeQuery({
                sql: 'SELECT * FROM "public"."users" JOIN analytics.events ON users.id = analytics.events.user_id',
                params: [],
                dataSource: { source: 'internal' } as DataSource,
            })
            expect(q2.sql).toBe(
                'SELECT * FROM "users" JOIN analytics_events ON users.id = analytics_events.user_id'
            )

            // Does not rewrite when querying external source directly
            const qExternal = await plugin.beforeQuery({
                sql: 'SELECT * FROM public.users',
                params: [],
                dataSource: { source: 'external' } as DataSource,
            })
            expect(qExternal.sql).toBe('SELECT * FROM public.users')
        })

        it('logs errors to tmp_data_sync_errors when external query fails', async () => {
            const plugin = new DataSyncPlugin({
                tables: ['broken_table'],
            })
            plugin['dataSource'] = mockDataSource
            plugin['config'] = mockConfig

            vi.mocked(executeExternalQuery).mockRejectedValueOnce(
                new Error('Connection refused')
            )

            const results = await plugin.syncAllTables()
            expect(results).toEqual([
                {
                    table: 'broken_table',
                    rowsSynced: 0,
                    status: 'error',
                    error: 'Connection refused',
                },
            ])

            expect(
                executedInternalQueries.some((q) =>
                    q.sql.includes('INSERT INTO tmp_data_sync_errors')
                )
            ).toBe(true)
        })

        it('registers routes for /data-sync/status and /data-sync/trigger', async () => {
            const routes: Record<string, Function> = {}
            const mockApp = {
                use: vi.fn(),
                get: vi.fn((path: string, handler: Function) => {
                    routes[`GET:${path}`] = handler
                }),
                post: vi.fn((path: string, handler: Function) => {
                    routes[`POST:${path}`] = handler
                }),
            } as unknown as StarbaseApp

            const plugin = new DataSyncPlugin({ tables: ['users'] })
            plugin['dataSource'] = mockDataSource
            plugin['config'] = mockConfig

            await plugin.register(mockApp)

            const statusRes: Response = await routes['GET:/data-sync/status']()
            expect(statusRes.status).toBe(200)
            const statusBody = (await statusRes.json()) as any
            expect(statusBody.result.tables).toHaveLength(1)

            vi.mocked(executeExternalQuery)
                .mockResolvedValueOnce([])
                .mockResolvedValueOnce([])

            const triggerRes: Response = await routes[
                'POST:/data-sync/trigger'
            ]({
                req: {
                    json: async () => ({ table: 'users' }),
                },
            })
            expect(triggerRes.status).toBe(200)
        })
    })

    describe('Helper Utilities', () => {
        it('normalizes raw and object external rows and serializes values for SQLite', () => {
            expect(
                normalizeExternalRows({
                    columns: ['id', 'name'],
                    rows: [[1, 'Alice']],
                })
            ).toEqual([{ id: 1, name: 'Alice' }])

            expect(serializeSqliteValue(true)).toBe(1)
            expect(serializeSqliteValue(false)).toBe(0)
            expect(serializeSqliteValue({ a: 1 })).toBe('{"a":1}')
            expect(quoteSqlIdentifier('users')).toBe('users')
            expect(quoteSqlIdentifier('users.table')).toBe('"users.table"')
        })
    })
})
