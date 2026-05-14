import { describe, it, expect, vi, beforeEach } from 'vitest'
import { importTableFromCsvRoute } from './csv'
import { executeOperation } from '../export'
import type { DataSource } from '../types'
import type { StarbaseDBConfiguration } from '../handler'

vi.mock('../export', () => ({
    executeOperation: vi.fn(),
}))

vi.mock('../utils', () => ({
    createResponse: vi.fn(
        (data: unknown, message: string | undefined, status: number) =>
            new Response(JSON.stringify({ result: data, error: message }), {
                status,
                headers: { 'Content-Type': 'application/json' },
            })
    ),
}))

const mockDataSource: DataSource = {
    source: 'internal',
    rpc: { executeQuery: vi.fn() },
} as unknown as DataSource

const mockConfig: StarbaseDBConfiguration = {
    outerbaseApiKey: 'key',
    role: 'admin',
    features: { allowlist: false, rls: false, rest: false },
} as StarbaseDBConfiguration

beforeEach(() => {
    vi.clearAllMocks()
})

describe('importTableFromCsvRoute', () => {
    it('returns 400 when the request body is missing', async () => {
        const req = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'text/csv' },
        })
        const res = await importTableFromCsvRoute('users', req, mockDataSource, mockConfig)
        expect(res.status).toBe(400)
    })

    it('returns 400 for an unsupported Content-Type', async () => {
        const req = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: 'some data',
        })
        const res = await importTableFromCsvRoute('users', req, mockDataSource, mockConfig)
        expect(res.status).toBe(400)
        const body = await res.json() as any
        expect(body.error).toMatch(/Unsupported Content-Type/i)
    })

    it('returns 400 when multipart/form-data has no "file" field', async () => {
        const formData = new FormData()
        // Deliberately do not append a 'file' field
        formData.append('other', 'value')
        const req = new Request('http://localhost', {
            method: 'POST',
            body: formData,
        })
        const res = await importTableFromCsvRoute('users', req, mockDataSource, mockConfig)
        expect(res.status).toBe(400)
        const body = await res.json() as any
        expect(body.error).toMatch(/No file uploaded/i)
    })

    it('returns 400 when the CSV data is empty or invalid', async () => {
        const req = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'text/csv' },
            body: '',
        })
        const res = await importTableFromCsvRoute('users', req, mockDataSource, mockConfig)
        expect(res.status).toBe(400)
        const body = await res.json() as any
        expect(body.error).toMatch(/Invalid CSV format or empty data/i)
    })

    it('imports a raw text/csv payload successfully', async () => {
        vi.mocked(executeOperation).mockResolvedValue({ result: [], error: null } as any)
        const csv = 'id,name\n1,Alice\n2,Bob'
        const req = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'text/csv' },
            body: csv,
        })
        const res = await importTableFromCsvRoute('users', req, mockDataSource, mockConfig)
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.result.message).toMatch(/Imported 2 out of 2/)
        expect(executeOperation).toHaveBeenCalledTimes(2)
    })

    it('imports a JSON-wrapped CSV payload with column mapping', async () => {
        vi.mocked(executeOperation).mockResolvedValue({ result: [], error: null } as any)
        const payload = JSON.stringify({
            data: 'user_id,full_name\n10,Carol',
            columnMapping: { user_id: 'id', full_name: 'name' },
        })
        const req = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: payload,
        })
        const res = await importTableFromCsvRoute('people', req, mockDataSource, mockConfig)
        expect(res.status).toBe(200)
        // The INSERT should reference mapped column names
        const [ops] = vi.mocked(executeOperation).mock.calls[0] as any[]
        expect(ops[0].sql).toContain('id')
        expect(ops[0].sql).toContain('name')
    })

    it('imports a CSV file uploaded via multipart/form-data', async () => {
        vi.mocked(executeOperation).mockResolvedValue({ result: [], error: null } as any)
        const csvContent = 'id,value\n42,hello'
        const file = new File([csvContent], 'data.csv', { type: 'text/csv' })
        const formData = new FormData()
        formData.append('file', file)
        const req = new Request('http://localhost', {
            method: 'POST',
            body: formData,
        })
        const res = await importTableFromCsvRoute('items', req, mockDataSource, mockConfig)
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.result.message).toMatch(/Imported 1 out of 1/)
    })

    it('reports failed rows without aborting the whole import', async () => {
        vi.mocked(executeOperation)
            .mockResolvedValueOnce({ result: [], error: null } as any) // row 1 succeeds
            .mockRejectedValueOnce(new Error('UNIQUE constraint failed')) // row 2 fails
        const csv = 'id,name\n1,Alice\n2,Bob'
        const req = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'text/csv' },
            body: csv,
        })
        const res = await importTableFromCsvRoute('users', req, mockDataSource, mockConfig)
        expect(res.status).toBe(200)
        const body = await res.json() as any
        expect(body.result.message).toMatch(/Imported 1 out of 2/)
        expect(body.result.failedStatements).toHaveLength(1)
        expect(body.result.failedStatements[0].error).toMatch(/UNIQUE constraint/)
    })

    it('generates correct INSERT SQL with the table name and columns', async () => {
        vi.mocked(executeOperation).mockResolvedValue({ result: [], error: null } as any)
        const csv = 'email,age\ntest@example.com,30'
        const req = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'text/csv' },
            body: csv,
        })
        await importTableFromCsvRoute('accounts', req, mockDataSource, mockConfig)
        const [ops] = vi.mocked(executeOperation).mock.calls[0] as any[]
        expect(ops[0].sql).toMatch(/INSERT INTO accounts/)
        expect(ops[0].sql).toContain('email')
        expect(ops[0].sql).toContain('age')
        expect(ops[0].params).toEqual(['test@example.com', '30'])
    })
})
