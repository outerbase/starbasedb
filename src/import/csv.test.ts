import { describe, it, expect, vi, beforeEach } from 'vitest'
import { importTableFromCsvRoute } from './csv'
import { executeOperation } from '../export'
import type { DataSource } from '../types'
import type { StarbaseDBConfiguration } from '../handler'

vi.mock('../export', () => ({
    executeOperation: vi.fn(),
}))

describe('CSV Import Module (importTableFromCsvRoute)', () => {
    let mockDataSource: DataSource
    let mockConfig: StarbaseDBConfiguration

    beforeEach(() => {
        vi.clearAllMocks()
        mockDataSource = {
            source: 'internal',
            rpc: { executeQuery: vi.fn() },
        } as any
        mockConfig = { role: 'admin' }
    })

    it('should return 400 if request body is empty', async () => {
        const req = new Request('http://localhost/import/csv/users', {
            method: 'POST',
        })
        const res = await importTableFromCsvRoute(
            'users',
            req,
            mockDataSource,
            mockConfig
        )
        expect(res.status).toBe(400)
    })

    it('should return 400 for unsupported Content-Type', async () => {
        const req = new Request('http://localhost/import/csv/users', {
            method: 'POST',
            body: 'id,name\n1,Alice',
            headers: { 'Content-Type': 'text/plain' },
        })
        const res = await importTableFromCsvRoute(
            'users',
            req,
            mockDataSource,
            mockConfig
        )
        expect(res.status).toBe(400)
    })

    it('should import CSV from application/json with columnMapping', async () => {
        vi.mocked(executeOperation).mockResolvedValue({ status: 200 })
        const req = new Request('http://localhost/import/csv/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                data: 'full_name,user_age\nAlice,30\nBob,25',
                columnMapping: { full_name: 'name', user_age: 'age' },
            }),
        })
        const res = await importTableFromCsvRoute(
            'users',
            req,
            mockDataSource,
            mockConfig
        )
        expect(res.status).toBe(200)
        expect(executeOperation).toHaveBeenCalledTimes(2)
        const json = (await res.json()) as {
            result: { message: string; failedStatements: any[] }
        }
        expect(json.result.message).toContain('Imported 2 out of 2 records')
        expect(json.result.failedStatements).toEqual([])
    })

    it('should import raw text/csv and record failed statements', async () => {
        vi.mocked(executeOperation)
            .mockResolvedValueOnce({ status: 200 })
            .mockRejectedValueOnce(new Error('Constraint violation'))

        const req = new Request('http://localhost/import/csv/users', {
            method: 'POST',
            headers: { 'Content-Type': 'text/csv' },
            body: 'id,name\n1,Alice\n2,Bob',
        })
        const res = await importTableFromCsvRoute(
            'users',
            req,
            mockDataSource,
            mockConfig
        )
        expect(res.status).toBe(200)
        const json = (await res.json()) as {
            result: { message: string; failedStatements: any[] }
        }
        expect(json.result.message).toContain('Imported 1 out of 2 records')
        expect(json.result.failedStatements).toHaveLength(1)
    })

    it('should import CSV from multipart/form-data and reject missing file', async () => {
        vi.mocked(executeOperation).mockResolvedValue({ status: 200 })

        const emptyForm = new FormData()
        const missingReq = new Request('http://localhost/import/csv/users', {
            method: 'POST',
            body: emptyForm,
        })
        const missingRes = await importTableFromCsvRoute(
            'users',
            missingReq,
            mockDataSource,
            mockConfig
        )
        expect(missingRes.status).toBe(400)

        const form = new FormData()
        const file = new File(['id,name\n1,Alice'], 'users.csv', {
            type: 'text/csv',
        })
        form.append('file', file)
        const okReq = new Request('http://localhost/import/csv/users', {
            method: 'POST',
            body: form,
        })
        const okRes = await importTableFromCsvRoute(
            'users',
            okReq,
            mockDataSource,
            mockConfig
        )
        expect(okRes.status).toBe(200)
    })

    it('should return 400 when CSV has no valid records and 500 on parse exception', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        const emptyCsvReq = new Request('http://localhost/import/csv/users', {
            method: 'POST',
            headers: { 'Content-Type': 'text/csv' },
            body: 'id,name',
        })
        const emptyRes = await importTableFromCsvRoute(
            'users',
            emptyCsvReq,
            mockDataSource,
            mockConfig
        )
        expect(emptyRes.status).toBe(400)

        const badJsonReq = new Request('http://localhost/import/csv/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: 'not-json',
        })
        const errRes = await importTableFromCsvRoute(
            'users',
            badJsonReq,
            mockDataSource,
            mockConfig
        )
        expect(errRes.status).toBe(500)
    })
})
