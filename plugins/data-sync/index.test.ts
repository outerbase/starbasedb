import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StarbaseApp } from '../../src/handler'
import { DataSource } from '../../src/types'
import { PostgresSyncSource } from '../postgres-sync'
import {
    ColumnDefinition,
    DatabaseSyncSource,
    DataSyncPlugin,
    MySQLSync,
    MySQLSyncSource,
    normalizeToQueryResult,
    QueryResult,
    ReplicationPlugin,
    sanitizeSQLiteValue,
    SQLiteSync,
    SQLiteSyncSource,
    TableMetadata,
    TableSyncConfig,
} from './index'

class MockSyncSource extends DatabaseSyncSource {
    get dialect(): string {
        return 'postgresql'
    }

    validateConnection = vi.fn().mockResolvedValue(true)

    getTableSchema = vi.fn().mockResolvedValue([
        { name: 'id', type: 'integer', nullable: false, primaryKey: true },
        { name: 'name', type: 'varchar(255)', nullable: true },
        {
            name: 'created_at',
            type: 'timestamp with time zone',
            nullable: false,
        },
    ] as ColumnDefinition[])

    getIncrementalData = vi.fn().mockResolvedValue({
        rows: [
            [1, 'John', '2023-01-01T00:00:00Z'],
            [2, 'Jane', '2023-01-02T00:00:00Z'],
        ],
        columns: ['id', 'name', 'created_at'],
    } as QueryResult)

    mapDataType = vi.fn().mockImplementation((sourceType: string) => {
        const typeMap: Record<string, string> = {
            integer: 'INTEGER',
            'varchar(255)': 'TEXT',
            'timestamp with time zone': 'TEXT',
            boolean: 'INTEGER',
            jsonb: 'TEXT',
            text: 'TEXT',
        }
        return typeMap[sourceType] || 'TEXT'
    })

    validateTableStructure = vi.fn().mockResolvedValue({
        valid: true,
        errors: [],
    })
}

describe('DataSyncPlugin & Sync Sources', () => {
    let dataSyncPlugin: DataSyncPlugin
    let mockSyncSource: MockSyncSource
    let mockDataSource: DataSource
    let mockExecuteQuery: ReturnType<typeof vi.fn>
    let mockApp: StarbaseApp
    let registeredRoutes: {
        get: Record<string, Function>
        post: Record<string, Function>
        middlewares: Function[]
    }

    beforeEach(() => {
        vi.clearAllMocks()

        mockExecuteQuery = vi.fn().mockResolvedValue({
            rows: [],
            columns: [],
        })

        mockDataSource = {
            source: 'internal',
            external: {
                dialect: 'postgresql',
                connection: {
                    host: 'localhost',
                    port: 5432,
                    database: 'test',
                    user: 'postgres',
                    password: 'password',
                },
            } as any,
            rpc: {
                executeQuery: mockExecuteQuery,
            } as any,
        }

        registeredRoutes = {
            get: {},
            post: {},
            middlewares: [],
        }

        mockApp = {
            use: vi.fn((fn: Function) => {
                registeredRoutes.middlewares.push(fn)
            }),
            get: vi.fn((path: string, handler: Function) => {
                registeredRoutes.get[path] = handler
            }),
            post: vi.fn((path: string, handler: Function) => {
                registeredRoutes.post[path] = handler
            }),
        } as unknown as StarbaseApp

        mockSyncSource = new MockSyncSource({ dialect: 'postgresql' })
        dataSyncPlugin = new DataSyncPlugin(mockSyncSource, {
            sync_interval: 60,
            tables: ['users', 'orders'],
            auto_sync: false,
        })
    })

    afterEach(() => {
        dataSyncPlugin.stopPeriodicSync()
    })

    describe('Utility Functions (normalizeToQueryResult & sanitizeSQLiteValue)', () => {
        it('should normalize both object arrays and tabular results to QueryResult', () => {
            expect(normalizeToQueryResult(null)).toEqual({
                rows: [],
                columns: [],
            })
            expect(normalizeToQueryResult([])).toEqual({
                rows: [],
                columns: [],
            })

            const sdkObjectRows = [
                { id: 1, name: 'Alice' },
                { id: 2, name: 'Bob' },
            ]
            expect(normalizeToQueryResult(sdkObjectRows)).toEqual({
                columns: ['id', 'name'],
                rows: [
                    [1, 'Alice'],
                    [2, 'Bob'],
                ],
            })

            const tabularResult = {
                columns: ['id', 'name'],
                rows: [[1, 'Alice']],
            }
            expect(normalizeToQueryResult(tabularResult)).toEqual(tabularResult)

            const wrappedObjectRows = {
                rows: [{ id: 10, title: 'Hello' }],
                columns: [],
            }
            expect(normalizeToQueryResult(wrappedObjectRows)).toEqual({
                columns: ['id', 'title'],
                rows: [[10, 'Hello']],
            })
        })

        it('should sanitize values properly for Durable Object SQLite', () => {
            expect(sanitizeSQLiteValue(undefined)).toBeNull()
            expect(sanitizeSQLiteValue(null)).toBeNull()
            expect(sanitizeSQLiteValue(true)).toBe(1)
            expect(sanitizeSQLiteValue(false)).toBe(0)
            expect(sanitizeSQLiteValue(BigInt(42))).toBe(42)
            expect(sanitizeSQLiteValue(BigInt('9007199254740993123'))).toBe(
                '9007199254740993123'
            )

            const date = new Date('2024-06-01T12:00:00.000Z')
            expect(sanitizeSQLiteValue(date)).toBe('2024-06-01T12:00:00.000Z')

            const bytes = new Uint8Array([1, 2, 3])
            expect(sanitizeSQLiteValue(bytes)).toBe(bytes)

            expect(sanitizeSQLiteValue({ role: 'admin', tags: ['a'] })).toBe(
                '{"role":"admin","tags":["a"]}'
            )
            expect(sanitizeSQLiteValue(['tag1', 'tag2'])).toBe(
                '["tag1","tag2"]'
            )
            expect(sanitizeSQLiteValue('plain text')).toBe('plain text')
        })
    })

    describe('Initialization & Configuration', () => {
        it('should support new DataSyncPlugin(syncSource, opts) (@Brayden syntax)', () => {
            const pgSource = new PostgresSyncSource({ dialect: 'postgresql' })
            const plugin = new DataSyncPlugin(pgSource, {
                sync_interval: 60,
                tables: ['users', 'person'],
            })

            expect(ReplicationPlugin).toBe(DataSyncPlugin)
            const config = plugin.getConfig()
            expect(config.sync_interval).toBe(60)
            expect(config.auto_sync).toBe(true)
            expect(config.tables).toEqual([
                {
                    name: 'users',
                    timestamp_column: 'created_at',
                    id_column: 'id',
                    batch_size: 1000,
                },
                {
                    name: 'person',
                    timestamp_column: 'created_at',
                    id_column: 'id',
                    batch_size: 1000,
                },
            ])
        })

        it('should support new DataSyncPlugin(opts) without explicit syncSource and auto-select dialect adapter', async () => {
            const plugin = new DataSyncPlugin({
                sync_interval: 120,
                tables: ['users'],
                auto_sync: false,
            })

            expect(plugin.getConfig().sync_interval).toBe(120)

            await plugin.setDataSource({
                source: 'internal',
                external: { dialect: 'mysql' } as any,
                rpc: { executeQuery: mockExecuteQuery } as any,
            })
            expect(plugin['syncSource']).toBeInstanceOf(MySQLSyncSource)

            await plugin.setDataSource({
                source: 'internal',
                external: { dialect: 'sqlite' } as any,
                rpc: { executeQuery: mockExecuteQuery } as any,
            })
            expect(plugin['syncSource']).toBeInstanceOf(SQLiteSyncSource)

            await plugin.setDataSource({
                source: 'internal',
                external: { dialect: 'postgresql' } as any,
                rpc: { executeQuery: mockExecuteQuery } as any,
            })
            expect(plugin['syncSource']).toBeInstanceOf(PostgresSyncSource)
        })

        it('should map table names cleanly in internal SQLite without tmp_ prefix or literal dots', () => {
            const plugin = new DataSyncPlugin(mockSyncSource, {
                tables: [
                    'users',
                    'public.products',
                    'analytics.events',
                    {
                        name: 'orders',
                        schema: 'sales',
                        timestamp_column: 'updated_at',
                        id_column: 'order_id',
                        batch_size: 500,
                    },
                    {
                        name: 'legacy_accounts',
                        target_table: 'accounts_replica',
                        cursor_column: 'seq_no',
                    },
                ],
                auto_sync: false,
            })

            const tableKeys = Array.from(plugin['tables'].keys())
            expect(tableKeys).toEqual([
                'users',
                'products',
                'analytics_events',
                'sales_orders',
                'accounts_replica',
            ])
        })
    })

    describe('Plugin Registration & Metadata Initialization', () => {
        it('should register routes, validate connection, and create tmp_data_sync_metadata when dataSource is set', async () => {
            await dataSyncPlugin.setDataSource(mockDataSource)
            await dataSyncPlugin.register(mockApp)

            expect(mockApp.use).toHaveBeenCalled()
            expect(mockApp.get).toHaveBeenCalledWith(
                '/sync-status',
                expect.any(Function)
            )
            expect(mockApp.get).toHaveBeenCalledWith(
                '/sync/status',
                expect.any(Function)
            )
            expect(mockApp.post).toHaveBeenCalledWith(
                '/sync',
                expect.any(Function)
            )
            expect(mockApp.post).toHaveBeenCalledWith(
                '/sync/trigger',
                expect.any(Function)
            )
            expect(mockApp.get).toHaveBeenCalledWith(
                '/sync-data',
                expect.any(Function)
            )
            expect(mockApp.get).toHaveBeenCalledWith(
                '/sync/data',
                expect.any(Function)
            )

            expect(mockSyncSource.validateConnection).toHaveBeenCalled()
            expect(mockExecuteQuery).toHaveBeenCalledWith({
                sql: expect.stringContaining(
                    'CREATE TABLE IF NOT EXISTS tmp_data_sync_metadata'
                ),
                params: [],
            })
            expect(mockExecuteQuery).toHaveBeenCalledWith({
                sql: 'SELECT * FROM tmp_data_sync_metadata',
                params: [],
            })
        })

        it('should throw error during register() when pre-set dataSource fails connection validation', async () => {
            mockSyncSource.validateConnection.mockResolvedValueOnce(false)
            await dataSyncPlugin.setDataSource(mockDataSource)

            await expect(dataSyncPlugin.register(mockApp)).rejects.toThrow(
                'Failed to validate connection to external postgresql database'
            )
        })

        it('should lazily initialize and sync inside Hono middleware when dataSource is provided per request', async () => {
            const lazyPlugin = new DataSyncPlugin(mockSyncSource, {
                sync_interval: 60,
                tables: ['users'],
                auto_sync: true,
            })

            await lazyPlugin.register(mockApp)
            expect(mockSyncSource.getTableSchema).not.toHaveBeenCalled()

            const middleware = registeredRoutes.middlewares[0]
            const mockContext = {
                get: vi.fn((key: string) => {
                    if (key === 'dataSource') return mockDataSource
                    if (key === 'config') return { role: 'admin' }
                    return undefined
                }),
            }
            const next = vi.fn().mockResolvedValue(undefined)

            await middleware(mockContext, next)

            expect(next).toHaveBeenCalled()
            expect(mockSyncSource.getTableSchema).toHaveBeenCalledWith(
                'users',
                undefined
            )
            expect(mockExecuteQuery).toHaveBeenCalledWith({
                sql: expect.stringContaining(
                    'CREATE TABLE IF NOT EXISTS tmp_data_sync_metadata'
                ),
                params: [],
            })
            expect(mockExecuteQuery).toHaveBeenCalledWith({
                sql: expect.stringContaining(
                    'CREATE TABLE IF NOT EXISTS users'
                ),
                params: [],
            })
        })
    })

    describe('End-to-End Table Sync Operations (syncTable & syncAll)', () => {
        beforeEach(async () => {
            await dataSyncPlugin.setDataSource(mockDataSource)
            await dataSyncPlugin.register(mockApp)
            mockExecuteQuery.mockClear()
        })

        it('should sync table successfully, creating SQLite table with PRIMARY KEY and updating tmp_data_sync_metadata', async () => {
            const result = await dataSyncPlugin.syncTable('users')

            expect(result.table).toBe('users')
            expect(result.rowsSynced).toBe(2)
            expect(result.lastSyncId).toBe(2)

            expect(mockSyncSource.validateTableStructure).toHaveBeenCalledWith(
                'users',
                expect.objectContaining({ name: 'users' })
            )
            expect(mockSyncSource.getTableSchema).toHaveBeenCalledWith(
                'users',
                undefined
            )

            // Verify table is created as 'users' (NOT 'tmp_users') with PRIMARY KEY
            expect(mockExecuteQuery).toHaveBeenCalledWith({
                sql: 'CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY NOT NULL, name TEXT, created_at TEXT NOT NULL)',
                params: [],
            })

            // Verify rows are upserted into 'users'
            expect(mockExecuteQuery).toHaveBeenCalledWith({
                sql: 'INSERT OR REPLACE INTO users (id, name, created_at) VALUES (?, ?, ?)',
                params: [1, 'John', '2023-01-01T00:00:00Z'],
            })
            expect(mockExecuteQuery).toHaveBeenCalledWith({
                sql: 'INSERT OR REPLACE INTO users (id, name, created_at) VALUES (?, ?, ?)',
                params: [2, 'Jane', '2023-01-02T00:00:00Z'],
            })

            // Verify metadata is persisted in tmp_data_sync_metadata
            expect(mockExecuteQuery).toHaveBeenCalledWith({
                sql: expect.stringContaining(
                    'INSERT OR REPLACE INTO tmp_data_sync_metadata'
                ),
                params: [
                    'users',
                    'users',
                    new Date('2023-01-02T00:00:00Z').getTime(),
                    '2',
                    null,
                    null,
                    2,
                    null,
                ],
            })
        })

        it('should sync tables without created_at or id columns seamlessly (like @Brayden person table)', async () => {
            const personPlugin = new DataSyncPlugin(mockSyncSource, {
                sync_interval: 60,
                tables: ['person'],
                auto_sync: false,
            })
            await personPlugin.setDataSource(mockDataSource)

            mockSyncSource.getTableSchema.mockResolvedValueOnce([
                { name: 'first_name', type: 'text', nullable: true },
                { name: 'last_name', type: 'text', nullable: true },
            ])
            mockSyncSource.getIncrementalData.mockResolvedValueOnce({
                columns: ['first_name', 'last_name'],
                rows: [
                    ['Brayden', 'Wilmoth'],
                    ['Ada', 'Lovelace'],
                ],
            })

            const syncResult = await personPlugin.syncTable('person')

            expect(syncResult.table).toBe('person')
            expect(syncResult.rowsSynced).toBe(2)

            // Verify getIncrementalData was called with timestamp_column and id_column cleared
            expect(mockSyncSource.getIncrementalData).toHaveBeenCalledWith(
                'person',
                expect.any(Object),
                expect.objectContaining({
                    name: 'person',
                    timestamp_column: undefined,
                    id_column: undefined,
                })
            )

            expect(mockExecuteQuery).toHaveBeenCalledWith({
                sql: 'CREATE TABLE IF NOT EXISTS person (first_name TEXT, last_name TEXT)',
                params: [],
            })
            expect(mockExecuteQuery).toHaveBeenCalledWith({
                sql: 'INSERT OR REPLACE INTO person (first_name, last_name) VALUES (?, ?)',
                params: ['Brayden', 'Wilmoth'],
            })
        })

        it('should sanitize Date, boolean, JSON, and undefined values during syncTable insert', async () => {
            mockSyncSource.getTableSchema.mockResolvedValueOnce([
                {
                    name: 'id',
                    type: 'integer',
                    nullable: false,
                    primaryKey: true,
                },
                { name: 'is_active', type: 'boolean', nullable: false },
                { name: 'profile', type: 'jsonb', nullable: true },
                {
                    name: 'created_at',
                    type: 'timestamp with time zone',
                    nullable: false,
                },
            ])

            const dateObj = new Date('2025-02-20T15:30:00.000Z')
            mockSyncSource.getIncrementalData.mockResolvedValueOnce({
                columns: ['id', 'is_active', 'profile', 'created_at'],
                rows: [[10, true, { plan: 'pro' }, dateObj]],
            })

            await dataSyncPlugin.syncTable('users')

            expect(mockExecuteQuery).toHaveBeenCalledWith({
                sql: 'INSERT OR REPLACE INTO users (id, is_active, profile, created_at) VALUES (?, ?, ?, ?)',
                params: [10, 1, '{"plan":"pro"}', '2025-02-20T15:30:00.000Z'],
            })
        })

        it('should track custom cursor_column watermarks in tmp_data_sync_metadata', async () => {
            const cursorPlugin = new DataSyncPlugin(mockSyncSource, {
                tables: [
                    {
                        name: 'events',
                        schema: 'analytics',
                        cursor_column: 'event_seq',
                        primary_key: 'event_seq',
                    },
                ],
                auto_sync: false,
            })
            await cursorPlugin.setDataSource(mockDataSource)

            mockSyncSource.getTableSchema.mockResolvedValueOnce([
                { name: 'event_seq', type: 'integer', nullable: false },
                { name: 'event_type', type: 'text', nullable: false },
            ])
            mockSyncSource.getIncrementalData.mockResolvedValueOnce({
                columns: ['event_seq', 'event_type'],
                rows: [
                    [501, 'signup'],
                    [502, 'purchase'],
                ],
            })

            const res = await cursorPlugin.syncTable('analytics.events')

            expect(res.table).toBe('analytics_events')
            expect(res.lastCursorValue).toBe(502)
            expect(
                cursorPlugin.getMetadata()['analytics_events']
            ).toMatchObject({
                lastCursorValue: 502,
                cursorColumn: 'event_seq',
                rowsSynced: 2,
            })
        })

        it('should handle table validation errors and persist sync_errors in tmp_data_sync_metadata', async () => {
            mockSyncSource.validateTableStructure.mockResolvedValueOnce({
                valid: false,
                errors: ['Table public.users does not exist'],
            })

            await expect(dataSyncPlugin.syncTable('users')).rejects.toThrow(
                'Table structure validation failed for users: Table public.users does not exist'
            )

            expect(mockExecuteQuery).toHaveBeenCalledWith({
                sql: expect.stringContaining(
                    'INSERT OR REPLACE INTO tmp_data_sync_metadata'
                ),
                params: [
                    'users',
                    'users',
                    0,
                    null,
                    null,
                    null,
                    0,
                    'Table structure validation failed for users: Table public.users does not exist',
                ],
            })
        })

        it('should sync all configured tables via syncAll() and continue if one table fails', async () => {
            mockSyncSource.validateTableStructure
                .mockResolvedValueOnce({
                    valid: false,
                    errors: ['Table users broken'],
                })
                .mockResolvedValueOnce({
                    valid: true,
                    errors: [],
                })

            const results = await dataSyncPlugin.syncAll()

            expect(results).toHaveLength(2)
            expect(results[0].table).toBe('users')
            expect(results[0].error).toContain('Table users broken')
            expect(results[1].table).toBe('orders')
            expect(results[1].rowsSynced).toBe(2)
        })
    })

    describe('Query Transformation (beforeQuery & afterQuery)', () => {
        let queryPlugin: DataSyncPlugin

        beforeEach(() => {
            queryPlugin = new DataSyncPlugin(mockSyncSource, {
                tables: [
                    'users',
                    'public.products',
                    'analytics.events',
                    {
                        name: 'accounts',
                        target_table: 'custom_accounts',
                    },
                ],
                auto_sync: false,
            })
        })

        it('should omit public. schema prefix in internal SQLite queries', async () => {
            const res1 = await queryPlugin.beforeQuery({
                sql: 'SELECT * FROM public.users WHERE id = 1',
                params: [],
            })
            expect(res1.sql).toBe('SELECT * FROM users WHERE id = 1')

            const res2 = await queryPlugin.beforeQuery({
                sql: 'SELECT * FROM "public"."users" LIMIT 50',
                params: [],
            })
            expect(res2.sql).toBe('SELECT * FROM "users" LIMIT 50')

            const res3 = await queryPlugin.beforeQuery({
                sql: 'SELECT * FROM public.unconfigured_table',
                params: [],
            })
            expect(res3.sql).toBe('SELECT * FROM unconfigured_table')
        })

        it('should rewrite custom schema.table references to schema_table in internal SQLite', async () => {
            const res1 = await queryPlugin.beforeQuery({
                sql: 'SELECT * FROM analytics.events ORDER BY id DESC',
                params: [],
            })
            expect(res1.sql).toBe(
                'SELECT * FROM analytics_events ORDER BY id DESC'
            )

            const res2 = await queryPlugin.beforeQuery({
                sql: 'SELECT * FROM "analytics"."events" LIMIT 10',
                params: [],
            })
            expect(res2.sql).toBe('SELECT * FROM "analytics_events" LIMIT 10')
        })

        it('should rewrite standalone table references when explicit target_table override is configured', async () => {
            const res = await queryPlugin.beforeQuery({
                sql: 'SELECT * FROM accounts WHERE active = 1',
                params: [],
            })
            expect(res.sql).toBe(
                'SELECT * FROM custom_accounts WHERE active = 1'
            )
        })

        it('should preserve single-quoted string literals without modification', async () => {
            const res = await queryPlugin.beforeQuery({
                sql: "SELECT * FROM public.users WHERE origin = 'public.users' AND tag = 'analytics.events'",
                params: [],
            })
            expect(res.sql).toBe(
                "SELECT * FROM users WHERE origin = 'public.users' AND tag = 'analytics.events'"
            )
        })

        it('should never rewrite sqlite_master, pragma_table_info, PRAGMA, or external source queries', async () => {
            const schemaQuery =
                "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type='table'"
            const res1 = await queryPlugin.beforeQuery({
                sql: schemaQuery,
                params: [],
            })
            expect(res1.sql).toBe(schemaQuery)

            const pragmaQuery = 'PRAGMA table_info(users)'
            const res2 = await queryPlugin.beforeQuery({
                sql: pragmaQuery,
                params: [],
            })
            expect(res2.sql).toBe(pragmaQuery)

            const extRes = await queryPlugin.beforeQuery({
                sql: 'SELECT * FROM public.users',
                params: [],
                dataSource: { source: 'external' } as any,
            })
            expect(extRes.sql).toBe('SELECT * FROM public.users')
        })

        it('should return query result unmodified in afterQuery', async () => {
            const rawResult = { rows: [[1, 'John']], columns: ['id', 'name'] }
            const out = await queryPlugin.afterQuery({
                sql: 'SELECT * FROM users',
                result: rawResult,
                isRaw: true,
            })
            expect(out).toBe(rawResult)
        })
    })

    describe('HTTP Monitoring & Control Endpoints', () => {
        beforeEach(async () => {
            await dataSyncPlugin.setDataSource(mockDataSource)
            await dataSyncPlugin.register(mockApp)
        })

        it('should return sync configuration and table metadata on GET /sync-status', async () => {
            await dataSyncPlugin.syncTable('users')

            const statusHandler = registeredRoutes.get['/sync-status']
            const response = await statusHandler()
            const body = await response.json()

            expect(response.status).toBe(200)
            expect(body.result.config.sync_interval).toBe(60)
            expect(body.result.tables.users).toBeDefined()
            expect(body.result.tables.users.lastSyncId).toBe(2)
        })

        it('should trigger manual sync on POST /sync for all tables or a specific table', async () => {
            const triggerHandler = registeredRoutes.post['/sync']

            const singleTableCtx = {
                req: {
                    json: vi.fn().mockResolvedValue({ table: 'users' }),
                },
            }
            const res1 = await triggerHandler(singleTableCtx)
            const body1 = await res1.json()
            expect(res1.status).toBe(200)
            expect(body1.result.status).toBe('Sync triggered')

            const allTablesCtx = {
                req: {
                    json: vi.fn().mockRejectedValue(new Error('No body')),
                },
            }
            const res2 = await triggerHandler(allTablesCtx)
            const body2 = await res2.json()
            expect(res2.status).toBe(200)
            expect(body2.result.status).toBe('Sync triggered')
        })

        it('should return replicated data preview on GET /sync-data', async () => {
            mockExecuteQuery.mockResolvedValue({
                columns: ['id', 'name'],
                rows: [[1, 'John']],
            })

            const dataHandler = registeredRoutes.get['/sync-data']
            const response = await dataHandler()
            const body = await response.json()

            expect(response.status).toBe(200)
            expect(body.result.tables.users).toEqual({
                columns: ['id', 'name'],
                rows: [[1, 'John']],
                count: 1,
            })
        })
    })

    describe('MySQLSyncSource Adapter', () => {
        let mysqlSource: MySQLSyncSource
        let mysqlExec: ReturnType<typeof vi.fn>

        beforeEach(async () => {
            mysqlExec = vi.fn()
            mysqlSource = new MySQLSyncSource({
                schema: 'app_db',
                queryExecutor: mysqlExec,
            })
            await mysqlSource.setDataSource({
                source: 'internal',
                external: { dialect: 'mysql' } as any,
                rpc: { executeQuery: vi.fn() } as any,
            })
        })

        it('should validate MySQL connection and map data types', async () => {
            expect(MySQLSync).toBe(MySQLSyncSource)
            expect(mysqlSource.dialect).toBe('mysql')

            mysqlExec.mockResolvedValueOnce([{ 'VERSION()': '8.0.35' }])
            expect(await mysqlSource.validateConnection()).toBe(true)

            expect(mysqlSource.mapDataType('int(11)')).toBe('INTEGER')
            expect(mysqlSource.mapDataType('tinyint(1)')).toBe('INTEGER')
            expect(mysqlSource.mapDataType('decimal(10,2)')).toBe('REAL')
            expect(mysqlSource.mapDataType('double')).toBe('REAL')
            expect(mysqlSource.mapDataType('longblob')).toBe('BLOB')
            expect(mysqlSource.mapDataType('varchar(255)')).toBe('TEXT')
            expect(mysqlSource.mapDataType('datetime')).toBe('TEXT')
        })

        it('should discover MySQL table schema and fetch incremental data', async () => {
            mysqlExec.mockResolvedValueOnce([
                {
                    COLUMN_NAME: 'id',
                    DATA_TYPE: 'int',
                    COLUMN_TYPE: 'int(11)',
                    IS_NULLABLE: 'NO',
                    COLUMN_DEFAULT: null,
                    CHARACTER_MAXIMUM_LENGTH: null,
                    COLUMN_KEY: 'PRI',
                },
                {
                    COLUMN_NAME: 'email',
                    DATA_TYPE: 'varchar',
                    COLUMN_TYPE: 'varchar(255)',
                    IS_NULLABLE: 'YES',
                    COLUMN_DEFAULT: null,
                    CHARACTER_MAXIMUM_LENGTH: 255,
                    COLUMN_KEY: '',
                },
            ])

            const cols = await mysqlSource.getTableSchema('customers')
            expect(cols).toEqual([
                {
                    name: 'id',
                    type: 'int',
                    nullable: false,
                    defaultValue: undefined,
                    primaryKey: true,
                },
                {
                    name: 'email',
                    type: 'varchar',
                    nullable: true,
                    defaultValue: undefined,
                    primaryKey: false,
                },
            ])

            mysqlExec.mockResolvedValueOnce([
                { id: 5, email: 'test@outerbase.com' },
            ])
            const data = await mysqlSource.getIncrementalData(
                'customers',
                { lastSyncTimestamp: 0, lastSyncId: 4 },
                { name: 'customers', id_column: 'id', batch_size: 100 }
            )

            expect(data).toEqual({
                columns: ['id', 'email'],
                rows: [[5, 'test@outerbase.com']],
            })
            expect(mysqlExec).toHaveBeenLastCalledWith(
                'SELECT * FROM customers WHERE id > ? ORDER BY id ASC LIMIT 100',
                [4]
            )
        })
    })

    describe('SQLiteSyncSource Adapter (Turso / Cloudflare D1 / StarbaseDB)', () => {
        let sqliteSource: SQLiteSyncSource
        let sqliteExec: ReturnType<typeof vi.fn>

        beforeEach(async () => {
            sqliteExec = vi.fn()
            sqliteSource = new SQLiteSyncSource({
                queryExecutor: sqliteExec,
            })
            await sqliteSource.setDataSource({
                source: 'internal',
                external: { dialect: 'sqlite' } as any,
                rpc: { executeQuery: vi.fn() } as any,
            })
        })

        it('should validate SQLite connection and map data types', async () => {
            expect(SQLiteSync).toBe(SQLiteSyncSource)
            expect(sqliteSource.dialect).toBe('sqlite')

            sqliteExec.mockResolvedValueOnce([{ 'sqlite_version()': '3.45.0' }])
            expect(await sqliteSource.validateConnection()).toBe(true)

            expect(sqliteSource.mapDataType('INTEGER')).toBe('INTEGER')
            expect(sqliteSource.mapDataType('BIGINT')).toBe('INTEGER')
            expect(sqliteSource.mapDataType('REAL')).toBe('REAL')
            expect(sqliteSource.mapDataType('FLOAT')).toBe('REAL')
            expect(sqliteSource.mapDataType('BLOB')).toBe('BLOB')
            expect(sqliteSource.mapDataType('TEXT')).toBe('TEXT')
        })

        it('should discover SQLite table schema via pragma_table_info and fetch incremental data', async () => {
            sqliteExec.mockResolvedValueOnce([
                {
                    name: 'id',
                    type: 'INTEGER',
                    notnull: 1,
                    dflt_value: null,
                    pk: 1,
                },
                {
                    name: 'title',
                    type: 'TEXT',
                    notnull: 0,
                    dflt_value: "'Untitled'",
                    pk: 0,
                },
            ])

            const cols = await sqliteSource.getTableSchema('posts')
            expect(cols).toEqual([
                {
                    name: 'id',
                    type: 'INTEGER',
                    nullable: false,
                    defaultValue: undefined,
                    primaryKey: true,
                },
                {
                    name: 'title',
                    type: 'TEXT',
                    nullable: true,
                    defaultValue: "'Untitled'",
                    primaryKey: false,
                },
            ])

            sqliteExec.mockResolvedValueOnce([{ id: 1, title: 'Hello Edge' }])
            const data = await sqliteSource.getIncrementalData(
                'posts',
                { lastSyncTimestamp: 0 },
                { name: 'posts', id_column: 'id', batch_size: 50 }
            )

            expect(data).toEqual({
                columns: ['id', 'title'],
                rows: [[1, 'Hello Edge']],
            })
            expect(sqliteExec).toHaveBeenLastCalledWith(
                'SELECT * FROM posts ORDER BY id ASC LIMIT 50',
                []
            )
        })
    })
})
