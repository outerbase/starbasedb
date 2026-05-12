import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { StarbaseDBConfiguration } from '../handler'
import type { DataSource } from '../types'
import { executeOperation } from '../export'
import { importTableFromCsvRoute } from './csv'

vi.mock('../export', () => ({
    executeOperation: vi.fn(),
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

describe('CSV Import Module', () => {
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
        expect(await response.json()).toEqual({
            result: undefined,
            error: 'Unsupported Content-Type',
        })
        expect(executeOperation).not.toHaveBeenCalled()
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
        expect(await response.json()).toEqual({
            result: undefined,
            error: 'No file uploaded',
        })
        expect(executeOperation).not.toHaveBeenCalled()
    })

    it('imports raw text/csv records', async () => {
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
        const payload = (await response.json()) as {
            result: { message: string; failedStatements: unknown[] }
        }
        expect(payload.result.message).toBe(
            'Imported 2 out of 2 records successfully. 0 records failed.'
        )
        expect(payload.result.failedStatements).toEqual([])
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
        expect(executeOperation).toHaveBeenNthCalledWith(
            2,
            [
                {
                    sql: 'INSERT INTO users (id, name) VALUES (?, ?)',
                    params: ['2', 'Bob'],
                },
            ],
            mockDataSource,
            mockConfig
        )
    })

    it('applies column mapping for JSON-wrapped CSV data', async () => {
        vi.mocked(executeOperation).mockResolvedValue([])

        const request = new Request('http://localhost', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                data: 'Full Name,Email\nAlice,a@example.com',
                columnMapping: {
                    'Full Name': 'name',
                    Email: 'email',
                },
            }),
        })

        await importTableFromCsvRoute(
            'users',
            request,
            mockDataSource,
            mockConfig
        )

        expect(executeOperation).toHaveBeenCalledWith(
            [
                {
                    sql: 'INSERT INTO users (name, email) VALUES (?, ?)',
                    params: ['Alice', 'a@example.com'],
                },
            ],
            mockDataSource,
            mockConfig
        )
    })

    it('reports partial success when a row insert fails', async () => {
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([])
            .mockRejectedValueOnce(new Error('Database Error'))

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
        const payload = (await response.json()) as {
            result: {
                message: string
                failedStatements: { statement: string; error: string }[]
            }
        }
        expect(payload.result.message).toBe(
            'Imported 1 out of 2 records successfully. 1 records failed.'
        )
        expect(payload.result.failedStatements).toEqual([
            {
                statement: 'INSERT INTO users (id, name) VALUES (?, ?)',
                error: 'Database Error',
            },
        ])
    })
})
