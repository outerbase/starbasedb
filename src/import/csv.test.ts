import { describe, expect, it, vi } from 'vitest'
import { importTableFromCsvRoute } from './csv'
import { DataSource } from '../types'
import { StarbaseDBConfiguration } from '../handler'

function createCsvMockDataSource(failOnValue?: string): DataSource {
    return {
        source: 'internal',
        rpc: {
            executeQuery: vi.fn(async ({ params }: { sql: string; params?: any[] }) => {
                if (failOnValue && params?.includes(failOnValue)) {
                    throw new Error('Constraint violation')
                }
                return []
            }),
            executeTransaction: vi.fn(async ({ operations }: { operations: any[] }) => {
                for (const op of operations) {
                    if (failOnValue && op.params?.includes(failOnValue)) {
                        throw new Error('Constraint violation')
                    }
                }
                return []
            }),
        } as any,
    }
}

describe('CSV Import Route (src/import/csv.ts)', () => {
    const config: StarbaseDBConfiguration = { role: 'admin' } as any

    it('returns 400 when request body is empty', async () => {
        const req = new Request('https://example.com/import/csv', {
            method: 'POST',
        })
        const res = await importTableFromCsvRoute(
            'users',
            req,
            createCsvMockDataSource(),
            config
        )
        expect(res.status).toBe(400)
        const json: any = await res.json()
        expect(json.error).toContain('Request body is empty')
    })

    it('returns 400 for unsupported Content-Type', async () => {
        const req = new Request('https://example.com/import/csv', {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: 'id,name\n1,Alice',
        })
        const res = await importTableFromCsvRoute(
            'users',
            req,
            createCsvMockDataSource(),
            config
        )
        expect(res.status).toBe(400)
        const json: any = await res.json()
        expect(json.error).toContain('Unsupported Content-Type')
    })

    it('imports raw text/csv body successfully', async () => {
        const ds = createCsvMockDataSource()
        const req = new Request('https://example.com/import/csv', {
            method: 'POST',
            headers: { 'Content-Type': 'text/csv' },
            body: 'id,name\n1,Alice\n2,Bob',
        })
        const res = await importTableFromCsvRoute('users', req, ds, config)
        expect(res.status).toBe(200)
        const json: any = await res.json()
        expect(json.result.message).toBe(
            'Imported 2 out of 2 records successfully. 0 records failed.'
        )
        expect(json.result.failedStatements).toHaveLength(0)
    })

    it('supports application/json with columnMapping and tracks failed records', async () => {
        const ds = createCsvMockDataSource('Bob')
        const req = new Request('https://example.com/import/csv', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                data: 'user_id,full_name\n1,Alice\n2,Bob',
                columnMapping: {
                    user_id: 'id',
                    full_name: 'name',
                },
            }),
        })
        const res = await importTableFromCsvRoute('users', req, ds, config)
        expect(res.status).toBe(200)
        const json: any = await res.json()
        expect(json.result.message).toBe(
            'Imported 1 out of 2 records successfully. 1 records failed.'
        )
        expect(json.result.failedStatements).toHaveLength(1)
        expect(json.result.failedStatements[0].statement).toContain(
            'INSERT INTO users (id, name) VALUES (?, ?)'
        )
    })

    it('returns 400 when CSV contains headers only and no valid rows', async () => {
        const ds = createCsvMockDataSource()
        const req = new Request('https://example.com/import/csv', {
            method: 'POST',
            headers: { 'Content-Type': 'text/csv' },
            body: 'id,name',
        })
        const res = await importTableFromCsvRoute('users', req, ds, config)
        expect(res.status).toBe(400)
        const json: any = await res.json()
        expect(json.error).toContain('Invalid CSV format or empty data')
    })
})
