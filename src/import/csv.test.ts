import { describe, it, expect, vi, beforeEach } from 'vitest'
import { importTableFromCsvRoute } from './csv'
import { executeOperation } from '../export'
import { DataSource } from '../types'
import { StarbaseDBConfiguration } from '../handler'

vi.mock('../export', () => ({
    executeOperation: vi.fn(),
}))

describe('importTableFromCsvRoute', () => {
    const mockDataSource: DataSource = {
        source: 'test_source',
        rpc: {
            executeQuery: vi.fn(),
            executeBatch: vi.fn(),
        },
    }
    const mockConfig: StarbaseDBConfiguration = {
        role: 'admin',
    } as any

    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('returns 400 when request body is empty', async () => {
        const req = new Request('http://localhost/import/csv', { method: 'POST' })
        const res = await importTableFromCsvRoute('users', req, mockDataSource, mockConfig)
        expect(res.status).toBe(400)
        const json: any = await res.json()
        expect(json.error).toBe('Request body is empty')
    })

    it('returns 400 on unsupported Content-Type', async () => {
        const req = new Request('http://localhost/import/csv', {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: 'id,name\n1,Alice',
        })
        const res = await importTableFromCsvRoute('users', req, mockDataSource, mockConfig)
        expect(res.status).toBe(400)
        const json: any = await res.json()
        expect(json.error).toBe('Unsupported Content-Type')
    })

    it('imports valid text/csv records successfully', async () => {
        vi.mocked(executeOperation).mockResolvedValueOnce(undefined as any)
        const req = new Request('http://localhost/import/csv', {
            method: 'POST',
            headers: { 'Content-Type': 'text/csv' },
            body: 'id,name\n1,Alice',
        })
        const res = await importTableFromCsvRoute('users', req, mockDataSource, mockConfig)
        expect(res.status).toBe(200)
        const json: any = await res.json()
        expect(json.data.message).toContain('Imported 1 out of 1 records successfully')
        expect(executeOperation).toHaveBeenCalledWith(
            [{ sql: 'INSERT INTO users (id, name) VALUES (?, ?)', params: ['1', 'Alice'] }],
            mockDataSource,
            mockConfig
        )
    })

    it('imports application/json with columnMapping and tracks failed statements', async () => {
        vi.mocked(executeOperation)
            .mockResolvedValueOnce(undefined as any)
            .mockRejectedValueOnce(new Error('Unique constraint failed'))

        const req = new Request('http://localhost/import/csv', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                data: 'user_id,full_name\n1,Alice\n2,Bob',
                columnMapping: { user_id: 'id', full_name: 'name' },
            }),
        })
        const res = await importTableFromCsvRoute('users', req, mockDataSource, mockConfig)
        expect(res.status).toBe(200)
        const json: any = await res.json()
        expect(json.data.message).toContain('Imported 1 out of 2 records successfully. 1 records failed.')
        expect(json.data.failedStatements).toHaveLength(1)
    })
})
