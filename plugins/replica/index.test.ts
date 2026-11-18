import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import {
    ReplicaPlugin,
    assertValidIdentifier,
    mapColumnTypeToSqlite,
    normalizeQueryRows,
    normalizeSqliteValue,
} from './index'
import { StarbaseDB, StarbaseDBConfiguration } from '../../src/handler'
import { DataSource } from '../../src/types'

function createMockDataSource(overrides: Partial<DataSource> = {}): DataSource {
    const executeQuery = vi.fn().mockResolvedValue([])
    return {
        source: 'internal',
        rpc: {
            executeQuery,
            getAlarm: vi.fn(),
            setAlarm: vi.fn(),
            deleteAlarm: vi.fn(),
            getStatistics: vi.fn(),
        } as any,
        external: {
            dialect: 'postgresql',
            host: 'localhost',
            port: 5432,
            user: 'postgres',
            password: 'secret',
            database: 'app',
            defaultSchema: 'public',
        },
        ...overrides,
    }
}

function createMockCtx(): ExecutionContext {
    return {
        waitUntil: vi.fn(),
        passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext
}

describe('ReplicaPlugin - Helpers & Initialization', () => {
    it('should initialize with default options', () => {
        const plugin = new ReplicaPlugin()
        expect(plugin.name).toBe('starbasedb:replica')
        expect(plugin.prefix).toBe('/replica')
        expect(plugin.tables).toEqual([])
        expect(plugin.batchSize).toBe(100)
        expect(plugin.adminOnly).toBe(true)
    })

    it('should initialize with custom options', () => {
        const plugin = new ReplicaPlugin({
            tables: ['users', { table: 'orders', primaryKey: 'order_id', batchSize: 50 }],
            batchSize: 25,
            adminOnly: false,
        })
        expect(plugin.tables).toHaveLength(2)
        expect(plugin.batchSize).toBe(25)
        expect(plugin.adminOnly).toBe(false)
    })

    it('should validate SQL identifiers and reject unsafe input', () => {
        expect(assertValidIdentifier('users_table_1')).toBe('users_table_1')
        expect(() => assertValidIdentifier('users; DROP TABLE users;--')).toThrow()
        expect(() => assertValidIdentifier('123invalid')).toThrow()
    })

    it('should map external SQL types to SQLite column types', () => {
        expect(mapColumnTypeToSqlite('integer')).toBe('INTEGER')
        expect(mapColumnTypeToSqlite('bigint')).toBe('INTEGER')
        expect(mapColumnTypeToSqlite('boolean')).toBe('INTEGER')
        expect(mapColumnTypeToSqlite('numeric')).toBe('REAL')
        expect(mapColumnTypeToSqlite('double precision')).toBe('REAL')
        expect(mapColumnTypeToSqlite('bytea')).toBe('BLOB')
        expect(mapColumnTypeToSqlite('character varying')).toBe('TEXT')
    })

    it('should normalize object array and raw column/row query results', () => {
        expect(normalizeQueryRows([{ id: 1, name: 'Ada' }])).toEqual([
            { id: 1, name: 'Ada' },
        ])
        expect(
            normalizeQueryRows({
                columns: ['id', 'name'],
                rows: [[2, 'Grace']],
            })
        ).toEqual([{ id: 2, name: 'Grace' }])
    })

    it('should normalize values for SQLite storage', () => {
        const now = new Date('2026-01-01T00:00:00.000Z')
        expect(normalizeSqliteValue(true)).toBe(1)
        expect(normalizeSqliteValue(false)).toBe(0)
        expect(normalizeSqliteValue(now)).toBe('2026-01-01T00:00:00.000Z')
        expect(normalizeSqliteValue({ a: 1 })).toBe('{"a":1}')
        expect(normalizeSqliteValue(undefined)).toBeNull()
    })
})

describe('ReplicaPlugin - HTTP Routes & Auth', () => {
    let config: StarbaseDBConfiguration

    beforeEach(() => {
        config = { role: 'admin' }
    })

    it('should reject POST /replica/sync for non-admin users', async () => {
        const plugin = new ReplicaPlugin({ tables: ['users'] })
        const starbase = new StarbaseDB({
            dataSource: createMockDataSource(),
            config: { role: 'client' },
            plugins: [plugin],
        })

        const res = await starbase.handle(
            new Request('http://localhost/replica/sync', { method: 'POST' }),
            createMockCtx()
        )
        expect(res.status).toBe(403)
    })

    it('should reject GET /replica/status for non-admin users', async () => {
        const plugin = new ReplicaPlugin({ tables: ['users'] })
        const starbase = new StarbaseDB({
            dataSource: createMockDataSource(),
            config: { role: 'client' },
            plugins: [plugin],
        })

        const res = await starbase.handle(
            new Request('http://localhost/replica/status', { method: 'GET' }),
            createMockCtx()
        )
        expect(res.status).toBe(403)
    })

    it('should return 400 when external data source is not configured', async () => {
        const plugin = new ReplicaPlugin({ tables: ['users'] })
        const starbase = new StarbaseDB({
            dataSource: createMockDataSource({ external: undefined }),
            config,
            plugins: [plugin],
        })

        const res = await starbase.handle(
            new Request('http://localhost/replica/sync', { method: 'POST' }),
            createMockCtx()
        )
        expect(res.status).toBe(400)
        const json = (await res.json()) as any
        expect(json.error).toContain('External data source is not configured')
    })

    it('should return 400 when no tables are configured', async () => {
        const plugin = new ReplicaPlugin({ tables: [] })
        const starbase = new StarbaseDB({
            dataSource: createMockDataSource(),
            config,
            plugins: [plugin],
        })

        const res = await starbase.handle(
            new Request('http://localhost/replica/sync', { method: 'POST' }),
            createMockCtx()
        )
        expect(res.status).toBe(400)
        const json = (await res.json()) as any
        expect(json.error).toContain('No tables configured')
    })
})

describe('ReplicaPlugin - Pull Synchronization & Pagination', () => {
    it('should create local table from external schema and sync rows with INSERT OR REPLACE', async () => {
        const dataSource = createMockDataSource()
        const externalExec = vi.fn(async ({ sql }: { sql: string }) => {
            if (sql.includes('information_schema.columns')) {
                return [
                    { name: 'id', type: 'integer' },
                    { name: 'email', type: 'varchar' },
                    { name: 'active', type: 'boolean' },
                ]
            }
            if (sql.includes('LIMIT 100 OFFSET 0')) {
                return [
                    { id: 1, email: 'a@example.com', active: true },
                    { id: 2, email: 'b@example.com', active: false },
                ]
            }
            return []
        })

        const plugin = new ReplicaPlugin({
            tables: ['users'],
            externalQueryExecutor: externalExec,
        })

        const starbase = new StarbaseDB({
            dataSource,
            config: { role: 'admin' },
            plugins: [plugin],
        })

        const res = await starbase.handle(
            new Request('http://localhost/replica/sync', { method: 'POST' }),
            createMockCtx()
        )
        expect(res.status).toBe(200)
        const json = (await res.json()) as any
        expect(json.result.totalRowsSynced).toBe(2)
        expect(json.result.results[0]).toMatchObject({
            table: 'users',
            rowsSynced: 2,
            pages: 1,
            status: 'success',
        })

        const rpcCalls = (dataSource.rpc.executeQuery as any).mock.calls.map(
            (call: any[]) => call[0]
        )
        expect(
            rpcCalls.some((c: any) =>
                c.sql.includes(
                    'CREATE TABLE IF NOT EXISTS "users" ("id" INTEGER PRIMARY KEY, "email" TEXT, "active" INTEGER)'
                )
            )
        ).toBe(true)
        expect(
            rpcCalls.some(
                (c: any) =>
                    c.sql.includes('INSERT OR REPLACE INTO "users"') &&
                    c.params[0] === 1 &&
                    c.params[2] === 1
            )
        ).toBe(true)
    })

    it('should paginate across multiple pages using batchSize and OFFSET', async () => {
        const dataSource = createMockDataSource()
        const externalExec = vi.fn(async ({ sql }: { sql: string }) => {
            if (sql.includes('information_schema.columns')) {
                return [
                    { name: 'id', type: 'integer' },
                    { name: 'title', type: 'text' },
                ]
            }
            if (sql.includes('LIMIT 2 OFFSET 0')) {
                return [
                    { id: 1, title: 'One' },
                    { id: 2, title: 'Two' },
                ]
            }
            if (sql.includes('LIMIT 2 OFFSET 2')) {
                return [
                    { id: 3, title: 'Three' },
                    { id: 4, title: 'Four' },
                ]
            }
            if (sql.includes('LIMIT 2 OFFSET 4')) {
                return [{ id: 5, title: 'Five' }]
            }
            return []
        })

        const plugin = new ReplicaPlugin({
            tables: ['posts'],
            batchSize: 2,
            externalQueryExecutor: externalExec,
        })

        const result = await plugin.syncTables({
            dataSource,
            config: { role: 'admin' },
        })

        expect(result.totalRowsSynced).toBe(5)
        expect(result.results[0]).toMatchObject({
            table: 'posts',
            rowsSynced: 5,
            pages: 3,
            status: 'success',
        })
    })

    it('should infer schema from first row when external schema metadata is empty', async () => {
        const dataSource = createMockDataSource()
        const externalExec = vi.fn(async ({ sql }: { sql: string }) => {
            if (sql.includes('information_schema.columns')) {
                return []
            }
            if (sql.includes('LIMIT 100 OFFSET 0')) {
                return [{ id: 10, score: 9.5, label: 'top' }]
            }
            return []
        })

        const plugin = new ReplicaPlugin({
            tables: ['metrics'],
            externalQueryExecutor: externalExec,
        })

        const result = await plugin.syncTables({
            dataSource,
            config: { role: 'admin' },
        })

        expect(result.totalRowsSynced).toBe(1)
        const rpcCalls = (dataSource.rpc.executeQuery as any).mock.calls.map(
            (call: any[]) => call[0].sql
        )
        expect(
            rpcCalls.some((sql: string) =>
                sql.includes(
                    'CREATE TABLE IF NOT EXISTS "metrics" ("id" INTEGER PRIMARY KEY, "score" REAL, "label" TEXT)'
                )
            )
        ).toBe(true)
    })

    it('should allow overriding tables and batchSize via POST /replica/sync JSON body', async () => {
        const dataSource = createMockDataSource()
        const externalExec = vi.fn(async ({ sql }: { sql: string }) => {
            if (sql.includes('information_schema.columns')) {
                return [{ name: 'id', type: 'integer' }]
            }
            if (sql.includes('FROM "public"."events"') && sql.includes('LIMIT 10 OFFSET 0')) {
                return [{ id: 99 }]
            }
            return []
        })

        const plugin = new ReplicaPlugin({
            tables: ['users'],
            externalQueryExecutor: externalExec,
        })

        const starbase = new StarbaseDB({
            dataSource,
            config: { role: 'admin' },
            plugins: [plugin],
        })

        const res = await starbase.handle(
            new Request('http://localhost/replica/sync', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tables: ['events'], batchSize: 10 }),
            }),
            createMockCtx()
        )

        expect(res.status).toBe(200)
        const json = (await res.json()) as any
        expect(json.result.results[0].table).toBe('events')
        expect(json.result.totalRowsSynced).toBe(1)
    })

    it('should record error status in tmp_replica_status when external query fails', async () => {
        const dataSource = createMockDataSource()
        const externalExec = vi.fn(async ({ sql }: { sql: string }) => {
            if (sql.includes('information_schema.columns')) {
                return [{ name: 'id', type: 'integer' }]
            }
            throw new Error('Upstream connection timeout')
        })

        const plugin = new ReplicaPlugin({
            tables: ['broken_table'],
            externalQueryExecutor: externalExec,
        })

        const result = await plugin.syncTables({
            dataSource,
            config: { role: 'admin' },
        })

        expect(result.totalRowsSynced).toBe(0)
        expect(result.results[0]).toMatchObject({
            table: 'broken_table',
            status: 'error',
            error: 'Upstream connection timeout',
        })

        const statusInsert = (dataSource.rpc.executeQuery as any).mock.calls.find(
            (call: any[]) =>
                call[0].sql.includes('INSERT OR REPLACE INTO tmp_replica_status')
        )
        expect(statusInsert[0].params[4]).toBe('error')
        expect(statusInsert[0].params[5]).toBe('Upstream connection timeout')
    })

    it('should return sync status rows from GET /replica/status', async () => {
        const statusRows = [
            {
                table_name: 'users',
                schema_name: 'public',
                last_synced_at: '2026-11-15T15:00:00.000Z',
                rows_synced: 42,
                status: 'success',
                error_message: null,
            },
        ]
        const dataSource = createMockDataSource({
            rpc: {
                executeQuery: vi.fn(async ({ sql }: { sql: string }) => {
                    if (sql.includes('FROM tmp_replica_status')) {
                        return statusRows
                    }
                    return []
                }),
            } as any,
        })

        const plugin = new ReplicaPlugin({ tables: ['users'], batchSize: 50 })
        const starbase = new StarbaseDB({
            dataSource,
            config: { role: 'admin' },
            plugins: [plugin],
        })

        const res = await starbase.handle(
            new Request('http://localhost/replica/status', { method: 'GET' }),
            createMockCtx()
        )
        expect(res.status).toBe(200)
        const json = (await res.json()) as any
        expect(json.result.configuredTables).toEqual(['users'])
        expect(json.result.batchSize).toBe(50)
        expect(json.result.externalConfigured).toBe(true)
        expect(json.result.tables).toEqual(statusRows)
    })

    it('should support SQLite external dialect with PRAGMA table_info and WHERE clause', async () => {
        const dataSource = createMockDataSource({
            external: {
                dialect: 'sqlite',
                provider: 'turso',
                uri: 'libsql://example.turso.io',
                token: 'tok',
            },
        })

        const externalExec = vi.fn(async ({ sql }: { sql: string }) => {
            if (sql.startsWith('PRAGMA table_info')) {
                return [
                    { name: 'id', type: 'INTEGER', pk: 1 },
                    { name: 'status', type: 'TEXT', pk: 0 },
                ]
            }
            if (sql.includes('WHERE status = \'active\'')) {
                return [{ id: 7, status: 'active' }]
            }
            return []
        })

        const plugin = new ReplicaPlugin({
            tables: [
                {
                    table: 'tasks',
                    where: "status = 'active'",
                    primaryKey: 'id',
                },
            ],
            externalQueryExecutor: externalExec,
        })

        const result = await plugin.syncTables({
            dataSource,
            config: { role: 'admin' },
        })

        expect(result.totalRowsSynced).toBe(1)
        expect(externalExec).toHaveBeenCalledWith(
            expect.objectContaining({
                sql: expect.stringContaining('PRAGMA table_info("tasks")'),
            })
        )
        expect(externalExec).toHaveBeenCalledWith(
            expect.objectContaining({
                sql: expect.stringContaining('WHERE status = \'active\''),
            })
        )
    })
})
