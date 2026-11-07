import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import {
    buildExternalPollQuery,
    buildReplicaTableDdl,
    normalizeTableConfig,
    ReplicationPlugin,
} from './index'
import { executeExternalQuery } from '../../src/operation'
import type { DataSource } from '../../src/types'
import type { StarbaseDBConfiguration } from '../../src/handler'

vi.mock('../../src/operation', () => ({
    executeExternalQuery: vi.fn(),
}))

let mockDataSource: DataSource
let mockConfig: StarbaseDBConfiguration

beforeEach(() => {
    vi.clearAllMocks()

    mockDataSource = {
        source: 'internal',
        external: {
            dialect: 'postgresql',
            host: 'db.example.supabase.co',
            port: 5432,
            user: 'postgres',
            password: 'secret',
            database: 'postgres',
        },
        rpc: {
            executeQuery: vi.fn().mockResolvedValue([]),
            setAlarm: vi.fn().mockResolvedValue(undefined),
            getAlarm: vi.fn().mockResolvedValue(null),
            deleteAlarm: vi.fn().mockResolvedValue(undefined),
            getStatistics: vi.fn(),
        },
    } as unknown as DataSource

    mockConfig = {
        outerbaseApiKey: 'ob-test-key',
        role: 'admin',
    }
})

describe('ReplicationPlugin query and schema builders', () => {
    it('normalizes string and object table configurations', () => {
        expect(normalizeTableConfig('users')).toEqual({
            table: 'users',
            targetTable: 'users',
            primaryKey: 'id',
            batchSize: 500,
        })

        expect(
            normalizeTableConfig({
                table: 'events',
                targetTable: 'local_events',
                cursorColumn: 'created_at',
                batchSize: 100,
            })
        ).toEqual({
            table: 'events',
            targetTable: 'local_events',
            cursorColumn: 'created_at',
            primaryKey: 'created_at',
            batchSize: 100,
            createTableSql: undefined,
        })
    })

    it('builds incremental poll queries with and without prior cursor watermarks', () => {
        const cfg = normalizeTableConfig({
            table: 'orders',
            cursorColumn: 'id',
            batchSize: 50,
        })

        const initialQuery = buildExternalPollQuery(cfg, null)
        expect(initialQuery.sql).toBe(
            'SELECT * FROM "orders" ORDER BY "id" ASC LIMIT 50'
        )
        expect(initialQuery.params).toEqual([])

        const incrementalQuery = buildExternalPollQuery(cfg, '42')
        expect(incrementalQuery.sql).toBe(
            'SELECT * FROM "orders" WHERE "id" > ? ORDER BY "id" ASC LIMIT 50'
        )
        expect(incrementalQuery.params).toEqual(['42'])
    })

    it('infers SQLite replica DDL from sample external rows', () => {
        const cfg = normalizeTableConfig({
            table: 'users',
            primaryKey: 'id',
        })
        const ddl = buildReplicaTableDdl(cfg, {
            id: 1,
            name: 'Alice',
            score: 98.5,
            is_active: true,
        })
        expect(ddl).toBe(
            'CREATE TABLE IF NOT EXISTS "users" ("id" INTEGER PRIMARY KEY, "name" TEXT, "score" REAL, "is_active" INTEGER)'
        )
    })
})

describe('ReplicationPlugin synchronization lifecycle', () => {
    it('replicates new rows from external source into internal SQLite and updates watermark', async () => {
        const plugin = new ReplicationPlugin({
            tables: [
                {
                    table: 'users',
                    cursorColumn: 'id',
                    batchSize: 25,
                },
            ],
            intervalMs: 30000,
        })

        vi.mocked(mockDataSource.rpc.executeQuery)
            .mockResolvedValueOnce([] as any)
            .mockResolvedValueOnce([] as any)
            .mockResolvedValue([] as any)

        vi.mocked(executeExternalQuery).mockResolvedValueOnce([
            { id: 10, name: 'Alice' },
            { id: 11, name: 'Bob' },
        ])

        const summary = await plugin.syncTable('users', {
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(summary.rowsSynced).toBe(2)
        expect(executeExternalQuery).toHaveBeenCalledTimes(1)
        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledWith(
            expect.objectContaining({
                sql: expect.stringContaining('INSERT OR REPLACE INTO "users"'),
                params: [10, 'Alice'],
            })
        )
    })

    it('advances cursor watermark on incremental table sync and schedules alarm', async () => {
        const plugin = new ReplicationPlugin({
            tables: [{ table: 'events', cursorColumn: 'created_at' }],
            intervalMs: 15000,
        })

        vi.mocked(mockDataSource.rpc.executeQuery)
            .mockResolvedValueOnce([] as any)
            .mockResolvedValueOnce([
                {
                    table_name: 'events',
                    last_cursor_value: '2026-01-01T00:00:00Z',
                    rows_synced: 5,
                },
            ] as any)
            .mockResolvedValue([] as any)

        vi.mocked(executeExternalQuery).mockResolvedValueOnce([
            { id: 6, created_at: '2026-01-02T00:00:00Z', type: 'signup' },
        ])

        const summaries = await plugin.syncAllTables({
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(summaries).toEqual([
            {
                table: 'events',
                targetTable: 'events',
                rowsSynced: 1,
                lastCursorValue: '2026-01-02T00:00:00Z',
            },
        ])
        expect(mockDataSource.rpc.setAlarm).toHaveBeenCalledTimes(1)
    })

    it('exposes /replication/sync and /replication/status routes on Hono app', async () => {
        const app = new Hono<any>()
        app.use('*', async (c, next) => {
            c.set('dataSource', mockDataSource)
            c.set('config', mockConfig)
            await next()
        })

        const plugin = new ReplicationPlugin({
            tables: [{ table: 'users', cursorColumn: 'id' }],
            autoStart: false,
        })
        await plugin.register(app)

        vi.mocked(executeExternalQuery).mockResolvedValueOnce([
            { id: 1, email: 'user@example.com' },
        ])

        const syncRes = await app.request('/replication/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ table: 'users' }),
        })
        expect(syncRes.status).toBe(200)
        const syncJson: any = await syncRes.json()
        expect(syncJson.result.tables[0].rowsSynced).toBe(1)

        const statusRes = await app.request('/replication/status')
        expect(statusRes.status).toBe(200)
    })
})
