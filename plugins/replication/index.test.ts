import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ReplicationPlugin } from './index'

describe('ReplicationPlugin (#72)', () => {
    let executedQueries: { sql: string; params: any[] }[] = []
    let mockDataSource: any

    beforeEach(() => {
        executedQueries = []
        mockDataSource = {
            rpc: {
                executeQuery: vi.fn(async (sql: string, params: any[] = []) => {
                    executedQueries.push({ sql: sql.trim(), params })
                    if (sql.includes('SELECT last_cursor')) {
                        return [{ last_cursor: '2025-01-01T00:00:00Z' }]
                    }
                    return []
                }),
            },
        }
    })

    it('replicates external table schema and rows into internal SQLite with cursor tracking', async () => {
        const externalRows = [
            { id: 1, email: 'alice@example.com', active: true, updated_at: '2025-01-02T00:00:00Z' },
            { id: 2, email: 'bob@example.com', active: false, updated_at: '2025-01-03T00:00:00Z' },
        ]

        const fetchRows = vi.fn().mockResolvedValueOnce(externalRows).mockResolvedValueOnce([])

        const plugin = new ReplicationPlugin({
            tables: [{ table: 'users', primaryKey: 'id', cursorColumn: 'updated_at', batchSize: 2 }],
            externalSource: { fetchRows },
        })

        ;(plugin as any).dataSource = mockDataSource

        const reports = await plugin.syncAll()
        expect(reports).toHaveLength(1)
        expect(reports[0]).toEqual({
            table: 'users',
            rowsSynced: 2,
            lastCursor: '2025-01-03T00:00:00Z',
            status: 'synced',
        })

        const sqlStatements = executedQueries.map((q) => q.sql)
        expect(sqlStatements.some((s) => s.includes('CREATE TABLE IF NOT EXISTS "users"'))).toBe(true)
        expect(sqlStatements.some((s) => s.includes('INSERT OR REPLACE INTO "users"'))).toBe(true)
    })

    it('reports failed status cleanly if external pull throws an error', async () => {
        const plugin = new ReplicationPlugin({
            tables: ['orders'],
            externalSource: {
                fetchRows: vi.fn().mockRejectedValue(new Error('Supabase connection timeout')),
            },
        })
        ;(plugin as any).dataSource = mockDataSource

        const report = await plugin.syncTable('orders')
        expect(report.status).toBe('failed')
        expect(report.error).toContain('Supabase connection timeout')
    })
})
