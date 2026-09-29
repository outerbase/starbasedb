import { describe, it, expect, vi, beforeEach } from 'vitest'
import { importTableFromCsvRoute } from './csv'
import type { DataSource } from '../types'
import type { StarbaseDBConfiguration } from '../handler'

// Mock executeOperation
vi.mock('../export', () => ({
    executeOperation: vi.fn(),
}))
import { executeOperation } from '../export'

describe('importTableFromCsvRoute', () => {
    let mockDataSource: DataSource
    let mockConfig: StarbaseDBConfiguration

    beforeEach(() => {
        vi.clearAllMocks()

        mockDataSource = {
            source: 'internal',
            cache: false,
            rpc: {
                executeQuery: vi.fn(),
            },
        } as any

        mockConfig = {
            role: 'client',
            features: { allowlist: false, rls: false },
        } as any
    })

    it('should return 400 if request body is empty', async () => {
        const request = new Request('http://localhost', { method: 'POST' })
        // A request without body will throw or have null body depending on environment, let's pass a Request with null body
        Object.defineProperty(request, 'body', { value: null })

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )
        expect(response.status).toBe(400)
        const data = await response.json()
        expect(data.error).toBe('Request body is empty')
    })

    it('should handle application/json content type', async () => {
        const csvData = { data: 'name,age\nAlice,30\nBob,25' }
        const request = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(csvData),
        })

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )
        expect(response.status).toBe(200)
        const data = await response.json()
        expect(data.result.message).toContain(
            'Imported 2 out of 2 records successfully'
        )
        expect(executeOperation).toHaveBeenCalledTimes(2)
    })

    it('should handle text/csv content type', async () => {
        const csvString = 'name,age\nAlice,30\nBob,25'
        const request = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'text/csv' },
            body: csvString,
        })

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )
        expect(response.status).toBe(200)
        expect(executeOperation).toHaveBeenCalledTimes(2)
    })

    it('should handle multipart/form-data content type', async () => {
        const formData = new FormData()
        // File object mock might be needed, using Blob as File
        formData.append(
            'file',
            new Blob(['name,age\nAlice,30'], { type: 'text/csv' }),
            'data.csv'
        )

        const request = new Request('http://localhost', {
            method: 'POST',
            body: formData,
        })
        // Request automatically sets multipart/form-data boundary

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )
        expect(response.status).toBe(200)
        expect(executeOperation).toHaveBeenCalledTimes(1)
    })

    it('should return 400 if multipart has no file', async () => {
        const formData = new FormData()
        const request = new Request('http://localhost', {
            method: 'POST',
            body: formData,
        })

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )
        expect(response.status).toBe(400)
        const data = await response.json()
        expect(data.error).toBe('No file uploaded')
    })

    it('should return 400 for unsupported content type', async () => {
        const request = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'application/xml' },
            body: '<xml></xml>',
        })

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )
        expect(response.status).toBe(400)
        const data = await response.json()
        expect(data.error).toBe('Unsupported Content-Type')
    })

    it('should return 400 if CSV has no valid records', async () => {
        const request = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'text/csv' },
            body: 'name,age', // header only, no records
        })

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )
        expect(response.status).toBe(400)
        const data = await response.json()
        expect(data.error).toBe('Invalid CSV format or empty data')
    })

    it('should report failed records', async () => {
        const request = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'text/csv' },
            body: 'name,age\nAlice,30\nBob,25',
        })

        vi.mocked(executeOperation)
            .mockRejectedValueOnce(new Error('DB Error'))
            .mockResolvedValueOnce(undefined as any)

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )
        expect(response.status).toBe(200)
        const data = await response.json()
        expect(data.result.message).toContain(
            'Imported 1 out of 2 records successfully. 1 records failed.'
        )
        expect(data.result.failedStatements.length).toBe(1)
    })

    it('should catch generic errors', async () => {
        const request = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{invalid json',
        })

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )
        expect(response.status).toBe(500)
        const data = await response.json()
        expect(data.error).toContain('Failed to import CSV data')
    })
})
