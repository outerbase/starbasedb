import { describe, it, expect, vi, beforeEach } from 'vitest'
import { importTableFromCsvRoute } from './csv'
import { executeOperation } from '../export'
import { DataSource } from '../types'
import { StarbaseDBConfiguration } from '../handler'

vi.mock('../export', () => ({
    executeOperation: vi.fn(),
}))

describe('CSV Import Route - importTableFromCsvRoute', () => {
    const mockDataSource = { source: 'internal' } as DataSource
    const mockConfig: StarbaseDBConfiguration = { role: 'admin' }

    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('should return 400 when request body is empty', async () => {
        const request = new Request('http://localhost/import/csv/users', {
            method: 'POST',
            headers: { 'Content-Type': 'text/csv' },
        })

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )
        const json: any = await response.json()

        expect(response.status).toBe(400)
        expect(json.error).toBe('Request body is empty')
    })

    it('should return 400 for unsupported Content-Type', async () => {
        const request = new Request('http://localhost/import/csv/users', {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: 'id,name\n1,Alice',
        })

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )
        const json: any = await response.json()

        expect(response.status).toBe(400)
        expect(json.error).toBe('Unsupported Content-Type')
    })

    it('should import raw text/csv records successfully', async () => {
        vi.mocked(executeOperation).mockResolvedValue([])
        const request = new Request('http://localhost/import/csv/users', {
            method: 'POST',
            headers: { 'Content-Type': 'text/csv' },
            body: 'id,name\n1,Alice\n2,Bob\nincomplete_row',
        })

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )
        const json: any = await response.json()

        expect(response.status).toBe(200)
        expect(executeOperation).toHaveBeenCalledTimes(2)
        expect(executeOperation).toHaveBeenNthCalledWith(
            1,
            [
                {
                    sql: 'INSERT INTO users (id, name) VALUES (?, ?)',
                    params: ['1', 'Alice'],
                },
            ],
            mockDataSource,
            mockConfig
        )
        expect(json.result.message).toBe(
            'Imported 2 out of 2 records successfully. 0 records failed.'
        )
        expect(json.result.failedStatements).toEqual([])
    })

    it('should import application/json wrapped CSV with columnMapping', async () => {
        vi.mocked(executeOperation).mockResolvedValue([])
        const request = new Request('http://localhost/import/csv/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                data: 'uid,full_name\n10,Charlie',
                columnMapping: { uid: 'id', full_name: 'name' },
            }),
        })

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )
        const json: any = await response.json()

        expect(response.status).toBe(200)
        expect(executeOperation).toHaveBeenCalledWith(
            [
                {
                    sql: 'INSERT INTO users (id, name) VALUES (?, ?)',
                    params: ['10', 'Charlie'],
                },
            ],
            mockDataSource,
            mockConfig
        )
        expect(json.result.message).toContain('Imported 1 out of 1')
    })

    it('should import multipart/form-data file upload and reject missing file', async () => {
        const emptyForm = new FormData()
        const missingFileReq = new Request(
            'http://localhost/import/csv/users',
            {
                method: 'POST',
                body: emptyForm,
            }
        )
        const missingResp = await importTableFromCsvRoute(
            'users',
            missingFileReq,
            mockDataSource,
            mockConfig
        )
        expect(missingResp.status).toBe(400)
        expect(((await missingResp.json()) as any).error).toBe(
            'No file uploaded'
        )

        vi.mocked(executeOperation).mockResolvedValue([])
        const form = new FormData()
        form.append(
            'file',
            new File(['id,name\n7,Dana'], 'users.csv', { type: 'text/csv' })
        )
        const uploadReq = new Request('http://localhost/import/csv/users', {
            method: 'POST',
            body: form,
        })
        const uploadResp = await importTableFromCsvRoute(
            'users',
            uploadReq,
            mockDataSource,
            mockConfig
        )
        expect(uploadResp.status).toBe(200)
        expect(executeOperation).toHaveBeenCalledTimes(1)
    })

    it('should return 400 when CSV contains only header or no valid rows', async () => {
        const request = new Request('http://localhost/import/csv/users', {
            method: 'POST',
            headers: { 'Content-Type': 'text/csv' },
            body: 'id,name',
        })

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )
        const json: any = await response.json()

        expect(response.status).toBe(400)
        expect(json.error).toBe('Invalid CSV format or empty data')
    })

    it('should record failed row inserts without aborting remaining rows', async () => {
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([])
            .mockRejectedValueOnce(new Error('UNIQUE constraint failed'))
            .mockRejectedValueOnce({})

        const request = new Request('http://localhost/import/csv/users', {
            method: 'POST',
            headers: { 'Content-Type': 'text/csv' },
            body: 'id,name\n1,Alice\n1,Duplicate\n2,Broken',
        })

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )
        const json: any = await response.json()

        expect(response.status).toBe(200)
        expect(json.result.message).toBe(
            'Imported 1 out of 3 records successfully. 2 records failed.'
        )
        expect(json.result.failedStatements).toHaveLength(2)
        expect(json.result.failedStatements[0].error).toBe(
            'UNIQUE constraint failed'
        )
        expect(json.result.failedStatements[1].error).toBe('Unknown error')
    })

    it('should return 500 when JSON payload is malformed', async () => {
        const consoleErrorSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})
        const request = new Request('http://localhost/import/csv/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{bad json',
        })

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )
        const json: any = await response.json()

        expect(response.status).toBe(500)
        expect(json.error).toContain('Failed to import CSV data:')
        consoleErrorSpy.mockRestore()
    })
})
