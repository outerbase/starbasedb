import { describe, it, expect, vi, beforeEach } from 'vitest'
import { importTableFromCsvRoute } from './csv'
import { executeOperation } from '../export'
import type { DataSource } from '../types'
import type { StarbaseDBConfiguration } from '../handler'

vi.mock('../export', () => ({
    executeOperation: vi.fn(),
}))

let mockDataSource: DataSource
let mockConfig: StarbaseDBConfiguration

async function readJson(response: Response) {
    return (await response.json()) as {
        result?: {
            message: string
            failedStatements: { statement: string; error: string }[]
        }
        error?: string
    }
}

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

describe('CSV Import Module', () => {
    it('returns 400 when the request body is empty', async () => {
        const request = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'text/csv' },
        })

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(400)
        expect((await readJson(response)).error).toBe('Request body is empty')
    })

    it('returns 400 for unsupported Content-Type', async () => {
        const request = new Request('http://localhost', {
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

        expect(response.status).toBe(400)
        expect((await readJson(response)).error).toBe('Unsupported Content-Type')
    })

    it('imports raw text/csv data into the target table', async () => {
        vi.mocked(executeOperation).mockResolvedValue([])
        const request = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'text/csv' },
            body: 'id,name\n1,Alice\n2,Bob',
        })

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(200)
        expect(executeOperation).toHaveBeenNthCalledWith(
            1,
            [{ sql: 'INSERT INTO users (id, name) VALUES (?, ?)', params: ['1', 'Alice'] }],
            mockDataSource,
            mockConfig
        )
        expect(executeOperation).toHaveBeenNthCalledWith(
            2,
            [{ sql: 'INSERT INTO users (id, name) VALUES (?, ?)', params: ['2', 'Bob'] }],
            mockDataSource,
            mockConfig
        )
        expect((await readJson(response)).result?.message).toBe(
            'Imported 2 out of 2 records successfully. 0 records failed.'
        )
    })

    it('imports JSON-wrapped CSV data and applies column mappings', async () => {
        vi.mocked(executeOperation).mockResolvedValue([])
        const request = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                data: 'external_id,full_name\n1,Alice',
                columnMapping: {
                    external_id: 'id',
                    full_name: 'name',
                },
            }),
        })

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(200)
        expect(executeOperation).toHaveBeenCalledWith(
            [{ sql: 'INSERT INTO users (id, name) VALUES (?, ?)', params: ['1', 'Alice'] }],
            mockDataSource,
            mockConfig
        )
    })

    it('returns 400 when multipart form-data does not include a file', async () => {
        const request = new Request('http://localhost', {
            method: 'POST',
            body: new FormData(),
        })

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(400)
        expect((await readJson(response)).error).toBe('No file uploaded')
    })

    it('returns partial success details when one row fails to insert', async () => {
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([])
            .mockRejectedValueOnce(new Error('duplicate key'))
        const request = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'text/csv' },
            body: 'id,name\n1,Alice\n1,Alice Duplicate',
        })

        const response = await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )
        const json = await readJson(response)

        expect(response.status).toBe(200)
        expect(json.result?.message).toBe(
            'Imported 1 out of 2 records successfully. 1 records failed.'
        )
        expect(json.result?.failedStatements).toEqual([
            {
                statement: 'INSERT INTO users (id, name) VALUES (?, ?)',
                error: 'duplicate key',
            },
        ])
    })
})
