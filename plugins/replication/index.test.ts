import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { ReplicationPlugin } from './index'
import type { StarbaseApp } from '../../src/handler'
import type { DataSource } from '../../src/types'

function createInMemoryInternalRpc() {
    const tables = new Map<string, { columns: { name: string; type: string }[]; rows: Record<string, any>[] }>()
    let alarmTime: number | null = null

    const executeQuery = vi.fn(async ({ sql, params = [] }: { sql: string; params?: any[] }) => {
        const normalized = sql.trim().replace(/\s+/g, ' ')

        if (normalized.startsWith('CREATE TABLE IF NOT EXISTS _starbase_replication_state')) {
            if (!tables.has('_starbase_replication_state')) {
                tables.set('_starbase_replication_state', {
                    columns: [
                        { name: 'table_name', type: 'TEXT' },
                        { name: 'target_table', type: 'TEXT' },
                        { name: 'cursor_column', type: 'TEXT' },
                        { name: 'last_cursor_value', type: 'TEXT' },
                        { name: 'primary_key', type: 'TEXT' },
                        { name: 'sync_mode', type: 'TEXT' },
                        { name: 'rows_replicated', type: 'INTEGER' },
                        { name: 'status', type: 'TEXT' },
                        { name: 'last_error', type: 'TEXT' },
                        { name: 'retry_count', type: 'INTEGER' },
                        { name: 'last_synced_at', type: 'TEXT' },
                        { name: 'updated_at', type: 'TEXT' },
                    ],
                    rows: [],
                })
            }
            return []
        }

        if (normalized.startsWith('INSERT INTO _starbase_replication_state')) {
            const tbl = tables.get('_starbase_replication_state')!
            const row = {
                table_name: params[0],
                target_table: params[1],
                cursor_column: params[2],
                last_cursor_value: params[3],
                primary_key: params[4],
                sync_mode: params[5],
                rows_replicated: params[6],
                status: params[7],
                last_error: params[8],
                retry_count: params[9],
                last_synced_at: params[10],
                updated_at: new Date().toISOString(),
            }
            const idx = tbl.rows.findIndex((r) => r.table_name === row.table_name)
            if (idx >= 0) tbl.rows[idx] = row
            else tbl.rows.push(row)
            return []
        }

        if (normalized.startsWith('SELECT * FROM _starbase_replication_state WHERE table_name = ?')) {
            const tbl = tables.get('_starbase_replication_state')
            return tbl ? tbl.rows.filter((r) => r.table_name === params[0]) : []
        }

        if (normalized.startsWith('SELECT * FROM _starbase_replication_state')) {
            const tbl = tables.get('_starbase_replication_state')
            return tbl ? [...tbl.rows] : []
        }

        if (normalized.startsWith('DELETE FROM _starbase_replication_state WHERE table_name = ?')) {
            const tbl = tables.get('_starbase_replication_state')
            if (tbl) tbl.rows = tbl.rows.filter((r) => r.table_name !== params[0])
            return []
        }

        const pragmaMatch = normalized.match(/^PRAGMA table_info\("([^"]+)"\)/)
        if (pragmaMatch) {
            const tbl = tables.get(pragmaMatch[1])
            return tbl ? tbl.columns.map((c, cid) => ({ cid, name: c.name, type: c.type })) : []
        }

        const createMatch = normalized.match(/^CREATE TABLE IF NOT EXISTS "([^"]+)" \((.+)\)$/)
        if (createMatch) {
            const [, name, colsDef] = createMatch
            if (!tables.has(name)) {
                const columns = colsDef.split(',').map((part) => {
                    const tokens = part.trim().split(/\s+/)
                    return { name: tokens[0].replace(/"/g, ''), type: tokens[1] ?? 'TEXT' }
                })
                tables.set(name, { columns, rows: [] })
            }
            return []
        }

        const alterMatch = normalized.match(/^ALTER TABLE "([^"]+)" ADD COLUMN "([^"]+)" (\w+)$/)
        if (alterMatch) {
            const [, name, col, type] = alterMatch
            tables.get(name)?.columns.push({ name: col, type })
            return []
        }

        const deleteMatch = normalized.match(/^DELETE FROM "([^"]+)"$/)
        if (deleteMatch) {
            const tbl = tables.get(deleteMatch[1])
            if (tbl) tbl.rows = []
            return []
        }

        const insertMatch = normalized.match(/^INSERT(?: OR REPLACE)? INTO "([^"]+)" \(([^)]+)\) VALUES/)
        if (insertMatch) {
            const [, name, colsStr] = insertMatch
            const cols = colsStr.split(',').map((c) => c.trim().replace(/"/g, ''))
            const tbl = tables.get(name)!
            const record: Record<string, any> = {}
            cols.forEach((c, i) => {
                record[c] = params[i]
            })
            const pk = cols.includes('id') ? 'id' : cols[0]
            const existingIdx = tbl.rows.findIndex((r) => r[pk] === record[pk])
            if (existingIdx >= 0) tbl.rows[existingIdx] = { ...tbl.rows[existingIdx], ...record }
            else tbl.rows.push(record)
            return []
        }

        return []
    })

    return {
        tables,
        rpc: {
            executeQuery,
            setAlarm: vi.fn(async (t: number) => {
                alarmTime = t
            }),
            getAlarm: vi.fn(async () => alarmTime),
            deleteAlarm: vi.fn(async () => {
                alarmTime = null
            }),
            getStatistics: vi.fn(),
        },
        getAlarmTime: () => alarmTime,
    }
}

describe('ReplicationPlugin', () => {
    let internal: ReturnType<typeof createInMemoryInternalRpc>
    let dataSource: DataSource

    beforeEach(() => {
        vi.clearAllMocks()
        internal = createInMemoryInternalRpc()
        dataSource = {
            rpc: internal.rpc as any,
            source: 'external',
            external: {
                dialect: 'postgresql',
                host: 'db.example.com',
                port: 5432,
                user: 'postgres',
                password: 'secret',
                database: 'app',
            },
        }
    })

    it('performs initial table creation and incremental cursor pagination', async () => {
        const externalRows = [
            { id: 1, name: 'Alice', updated_at: '2026-01-01T00:00:00Z' },
            { id: 2, name: 'Bob', updated_at: '2026-01-02T00:00:00Z' },
            { id: 3, name: 'Carol', updated_at: '2026-01-03T00:00:00Z' },
        ]
        const externalQueryFn = vi.fn(async ({ sql, params }: { sql: string; params: unknown[] }) => {
            if (params.length > 0) {
                const cursor = String(params[0])
                return externalRows.filter((r) => r.updated_at > cursor).slice(0, 2)
            }
            return externalRows.slice(0, 2)
        })

        const plugin = new ReplicationPlugin({
            tables: [{ tableName: 'users', cursorColumn: 'updated_at', primaryKey: 'id', batchSize: 2 }],
            externalQueryFn,
        })
        plugin.setContext(dataSource, { role: 'admin' })
        await plugin.init()

        const res = await plugin.syncTable('users')
        expect(res.status).toBe('success')
        expect(res.rowsSynced).toBe(3)
        expect(res.lastCursor).toBe('2026-01-03T00:00:00Z')
        expect(internal.tables.get('users')?.rows).toHaveLength(3)

        // Subsequent incremental run only pulls rows newer than checkpoint
        externalRows.push({ id: 4, name: 'Dave', updated_at: '2026-01-04T00:00:00Z' })
        const res2 = await plugin.syncTable('users')
        expect(res2.rowsSynced).toBe(1)
        expect(res2.lastCursor).toBe('2026-01-04T00:00:00Z')
        expect(internal.tables.get('users')?.rows).toHaveLength(4)
        expect(externalQueryFn).toHaveBeenLastCalledWith(
            expect.objectContaining({
                params: ['2026-01-03T00:00:00Z'],
            })
        )
    })

    it('evolves target SQLite schema with ALTER TABLE ADD COLUMN when new source columns appear', async () => {
        let phase = 1
        const externalQueryFn = vi.fn(async () => {
            if (phase === 1) {
                return [{ id: 1, title: 'v1', updated_at: '2026-01-01T00:00:00Z' }]
            }
            return [{ id: 2, title: 'v2', updated_at: '2026-01-02T00:00:00Z', priority: 5 }]
        })

        const plugin = new ReplicationPlugin({
            tables: [{ tableName: 'tasks', cursorColumn: 'updated_at', primaryKey: 'id' }],
            externalQueryFn,
        })
        plugin.setContext(dataSource, { role: 'admin' })
        await plugin.init()

        await plugin.syncTable('tasks')
        phase = 2
        const res2 = await plugin.syncTable('tasks')

        expect(res2.columnsAdded).toEqual(['priority'])
        expect(internal.tables.get('tasks')?.columns.map((c) => c.name)).toContain('priority')
    })

    it('retries transient failures with backoff and records error state after exhaustion', async () => {
        const externalQueryFn = vi
            .fn()
            .mockRejectedValueOnce(new Error('network timeout'))
            .mockResolvedValueOnce([{ id: 10, name: 'Recovered' }])

        const plugin = new ReplicationPlugin({
            tables: [{ tableName: 'orders', primaryKey: 'id' }],
            maxRetries: 2,
            retryDelayMs: 1,
            externalQueryFn,
        })
        plugin.setContext(dataSource, { role: 'admin' })
        await plugin.init()

        const recovered = await plugin.syncTable('orders')
        expect(recovered.status).toBe('success')
        expect(recovered.rowsSynced).toBe(1)
        expect(externalQueryFn).toHaveBeenCalledTimes(2)

        const failingPlugin = new ReplicationPlugin({
            tables: [{ tableName: 'orders', primaryKey: 'id' }],
            maxRetries: 1,
            retryDelayMs: 1,
            externalQueryFn: vi.fn().mockRejectedValue(new Error('connection refused')),
        })
        failingPlugin.setContext(dataSource, { role: 'admin' })
        await failingPlugin.init()

        const failed = await failingPlugin.syncTable('orders')
        expect(failed.status).toBe('error')
        expect(failed.error).toContain('connection refused')
        const status = await failingPlugin.getStatus()
        expect(status[0].status).toBe('error')
        expect(status[0].retry_count).toBe(1)
    })

    it('registers HTTP routes (/status, /sync, /tables) and schedules DO alarms', async () => {
        const externalQueryFn = vi.fn(async () => [{ id: 1, email: 'a@b.com' }])
        const plugin = new ReplicationPlugin({
            tables: [{ tableName: 'customers', targetTable: 'customers_edge', primaryKey: 'id' }],
            syncIntervalMs: 30_000,
            externalQueryFn,
        })

        const app = new Hono() as unknown as StarbaseApp
        app.use('*', async (c, next) => {
            c.set('dataSource', dataSource)
            c.set('config', { role: 'admin' })
            await next()
        })
        await plugin.register(app)

        const syncResp = await app.request('http://localhost/replication/sync', { method: 'POST' })
        expect(syncResp.status).toBe(200)
        const syncJson = (await syncResp.json()) as any
        expect(syncJson.result.results[0].targetTable).toBe('customers_edge')
        expect(internal.rpc.setAlarm).toHaveBeenCalledTimes(1)

        const addResp = await app.request('http://localhost/replication/tables', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tableName: 'invoices', primaryKey: 'id' }),
        })
        expect(addResp.status).toBe(201)

        const statusResp = await app.request('http://localhost/replication/status')
        expect(statusResp.status).toBe(200)
        const statusJson = (await statusResp.json()) as any
        expect(statusJson.result.tables).toHaveLength(2)

        const delResp = await app.request('http://localhost/replication/tables/invoices', {
            method: 'DELETE',
        })
        expect(delResp.status).toBe(200)
        const statusAfterDel = await plugin.getStatus()
        expect(statusAfterDel).toHaveLength(1)
    })

    it('rejects invalid SQL identifiers cleanly', () => {
        expect(() => new ReplicationPlugin({ tables: [{ tableName: 'users; DROP TABLE users' }] })).toThrow(
            'Invalid SQL tableName'
        )
    })
})
