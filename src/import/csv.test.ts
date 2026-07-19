import { describe, it, expect, vi, beforeEach } from 'vitest'
import { importTableFromCsvRoute, parseCSV, mapRecord } from './csv'
import { executeOperation } from '../export'
import { createResponse } from '../utils'
import type { DataSource } from '../types'
import type { StarbaseDBConfiguration } from '../handler'

vi.mock('../export', () => ({
    executeOperation: vi.fn(),
}))

vi.mock('../utils', () => ({
    createResponse: vi.fn(
        (data, message, status) =>
            new Response(JSON.stringify({ result: data, error: message }), {
                status,
                headers: { 'Content-Type': 'application/json' },
            })
    ),
}))

let mockDataSource: DataSource
let mockConfig: StarbaseDBConfiguration

beforeEach(() => {
    vi.clearAllMocks()

    mockDataSource = {
        source: 'external',
        external: { dialect: 'sqlite' },
        rpc: { executeQuery: vi.fn() },
    } as any

    mockConfig = {
        outerbaseApiKey: 'mock-api-key',
        role: 'admin',
        features: { allowlist: true, rls: true, rest: true },
    }
})

describe('parseCSV', () => {
    it('should parse a basic CSV string into records', () => {
        const csv = 'name,age\nAlice,30\nBob,25'
        const result = parseCSV(csv)
        expect(result).toEqual([
            { name: 'Alice', age: '30' },
            { name: 'Bob', age: '25' },
        ])
    })

    it('should handle trailing newline', () => {
        const csv = 'name,age\nAlice,30\n'
        const result = parseCSV(csv)
        expect(result).toEqual([{ name: 'Alice', age: '30' }])
    })

    it('should handle extra whitespace in values', () => {
        const csv = 'name, age\nAlice, 30\nBob, 25'
        const result = parseCSV(csv)
        expect(result).toEqual([
            { name: 'Alice', age: '30' },
            { name: 'Bob', age: '25' },
        ])
    })

    it('should skip rows with incorrect column count', () => {
        const csv = 'name,age\nAlice,30,extra\nBob,25'
        const result = parseCSV(csv)
        expect(result).toEqual([{ name: 'Bob', age: '25' }])
    })

    it('should return empty array for single-line CSV (headers only)', () => {
        const csv = 'name,age'
        const result = parseCSV(csv)
        expect(result).toEqual([])
    })

    it('should handle empty CSV string', () => {
        const result = parseCSV('')
        expect(result).toEqual([])
    })
})

describe('mapRecord', () => {
    it('should map columns using the provided mapping', () => {
        const record = { name: 'Alice', yearsOld: '30' }
        const mapping = { yearsOld: 'age' }
        const result = mapRecord(record, mapping)
        expect(result).toEqual({ name: 'Alice', age: '30' })
    })

    it('should keep original key when no mapping exists', () => {
        const record = { name: 'Alice', age: '30' }
        const result = mapRecord(record, {})
        expect(result).toEqual({ name: 'Alice', age: '30' })
    })

    it('should handle empty record', () => {
        const result = mapRecord({}, {})
        expect(result).toEqual({})
    })
})

describe('CSV Import Route', () => {
    it('should return 400 for empty request body', async () => {
        const request = new Request('http://localhost', {
            method: 'POST',
            body: null as any,
        })

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(400)
    })

    it('should return 400 for unsupported Content-Type', async () => {
        const request = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain' },
            body: 'some data',
        })

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(400)
        const jsonResponse = (await response.json()) as { error?: string }
        expect(jsonResponse.error).toBe('Unsupported Content-Type')
    })

    it('should return 400 for invalid CSV content via JSON', async () => {
        const request = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data: '' }),
        })

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(400)
        const jsonResponse = (await response.json()) as { error?: string }
        expect(jsonResponse.error).toBe('Invalid CSV format or empty data')
    })

    it('should return 400 for no file uploaded in multipart form-data', async () => {
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
        const jsonResponse = (await response.json()) as { error?: string }
        expect(jsonResponse.error).toBe('No file uploaded')
    })

    it('should successfully insert CSV records via JSON content type', async () => {
        vi.mocked(executeOperation).mockResolvedValue([])

        const request = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                data: 'name,age\nAlice,30\nBob,25',
            }),
        })

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(200)
        const jsonResponse = (await response.json()) as {
            result: { message: string }
        }
        expect(jsonResponse.result.message).toBe(
            'Imported 2 out of 2 records successfully. 0 records failed.'
        )
        expect(executeOperation).toHaveBeenCalledTimes(2)
    })

    it('should handle column mapping during CSV import', async () => {
        vi.mocked(executeOperation).mockResolvedValue([])

        const request = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                data: 'full_name,email\nAlice Smith,alice@test.com',
                columnMapping: { full_name: 'name' },
            }),
        })

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(200)
        const calls = vi.mocked(executeOperation).mock.calls
        expect(calls[0][0][0].sql).toContain('name')
        expect(calls[0][0][0].sql).toContain('email')
    })

    it('should handle raw text/csv content type', async () => {
        vi.mocked(executeOperation).mockResolvedValue([])

        const request = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'text/csv' },
            body: 'name,age\nAlice,30',
        })

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(200)
    })

    it('should return partial success if some inserts fail', async () => {
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([])
            .mockRejectedValueOnce(new Error('Database Error'))

        const request = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                data: 'name,age\nAlice,30\nBob,25',
            }),
        })

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(200)
        const jsonResponse = (await response.json()) as {
            result: { message: string; failedStatements: any[] }
        }
        expect(jsonResponse.result.message).toBe(
            'Imported 1 out of 2 records successfully. 1 records failed.'
        )
        expect(jsonResponse.result.failedStatements.length).toBe(1)
    })

    it('should return 200 with failure count when all inserts fail', async () => {
        vi.mocked(executeOperation).mockRejectedValue(
            new Error('Database error')
        )

        const request = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                data: 'name\nAlice\nBob',
            }),
        })

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(200)
        const jsonResponse = (await response.json()) as {
            result: { message: string; failedStatements: any[] }
        }
        expect(jsonResponse.result.message).toBe(
            'Imported 0 out of 2 records successfully. 2 records failed.'
        )
        expect(jsonResponse.result.failedStatements.length).toBe(2)
    })
})
