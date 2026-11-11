import { describe, it, expect, vi } from 'vitest'
import { dumpDatabaseRoute } from './dump'

describe('Streaming Database Dump (#59)', () => {
    it('streams large tables in paginated batches without loading entire DB into memory', async () => {
        const totalRows = 1200
        const mockDataSource: any = {
            query: vi.fn(async ({ sql, params }: any) => {
                if (sql.includes("sqlite_master WHERE type='table' AND name NOT LIKE")) {
                    return { rows: [{ name: 'events' }] }
                }
                if (sql.includes("SELECT sql FROM sqlite_master")) {
                    return { rows: [{ sql: 'CREATE TABLE events (id INTEGER PRIMARY KEY, note TEXT)' }] }
                }
                const match = sql.match(/LIMIT\s+(\d+)\s+OFFSET\s+(\d+)/i)
                if (match) {
                    const limit = Number(match[1])
                    const offset = Number(match[2])
                    if (offset >= totalRows) return { rows: [] }
                    const count = Math.min(limit, totalRows - offset)
                    const rows = Array.from({ length: count }, (_, i) => ({
                        id: offset + i + 1,
                        note: `row_${offset + i + 1}_O'Reilly`,
                    }))
                    return { rows }
                }
                return { rows: [] }
            }),
        }

        const response = await dumpDatabaseRoute(mockDataSource, {} as any, {
            batchSize: 500,
            breathingIntervalMs: 1,
            yieldEveryBatches: 2,
        })

        expect(response.status).toBe(200)
        const text = await response.text()
        expect(text).toContain('CREATE TABLE events')
        expect(text).toContain("row_1_O''Reilly")
        expect(text).toContain("row_1200_O''Reilly")
        expect(text).toContain('COMMIT;')
    })
})
