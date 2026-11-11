import { describe, it, expect, vi } from 'vitest'
import { ExternalReplicationPlugin } from './index'

describe('ExternalReplicationPlugin (#72)', () => {
    it('pulls external table data, creates internal SQLite schema, and advances watermark cursor', async () => {
        const externalRows = [
            { id: 1, email: 'a@example.com', updated_at: '2026-11-11T10:00:00Z' },
            { id: 2, email: 'b@example.com', updated_at: '2026-11-11T11:00:00Z' },
        ]
        const externalDs: any = {
            query: vi.fn(async ({ sql, params }: any) => {
                if (params && params.length > 0 && params[0] === '2026-11-11T11:00:00Z') {
                    return { rows: [] }
                }
                return { rows: externalRows }
            }),
        }
        const executedInternalQueries: string[] = []
        const internalDs: any = {
            query: vi.fn(async ({ sql }: any) => {
                executedInternalQueries.push(sql)
                return { rows: [] }
            }),
        }

        const plugin = new ExternalReplicationPlugin({
            externalDataSource: externalDs,
            internalDataSource: internalDs,
            tables: [{ table: 'customers', primaryKey: 'id', watermarkColumn: 'updated_at' }],
        })

        const firstRun = await plugin.syncAll()
        expect(firstRun.tables[0].rowsSynced).toBe(2)
        expect(firstRun.tables[0].lastWatermark).toBe('2026-11-11T11:00:00Z')
        expect(executedInternalQueries[0]).toContain('CREATE TABLE IF NOT EXISTS "customers"')
        expect(executedInternalQueries[1]).toContain('INSERT OR REPLACE INTO "customers"')

        const secondRun = await plugin.syncAll()
        expect(secondRun.tables[0].rowsSynced).toBe(0)
    })
})
