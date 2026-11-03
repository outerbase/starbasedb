import { describe, it, expect, vi, beforeEach } from 'vitest'
import { exportTableToCsvRoute } from './csv'
import * as exportIndex from './index'
import { createResponse } from '../utils'
import type { DataSource } from '../types'
import type { StarbaseDBConfiguration } from '../handler'

vi.mock('./index', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./index')>()
    return {
        ...actual,
        executeOperation: vi.fn(),
        getTableData: vi.fn(),
        createExportResponse: vi.fn((data, fileName, contentType) =>
            actual.createExportResponse(data, fileName, contentType)
        ),
    }
})

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
        rpc: {
            executeQuery: vi.fn(),
        },
    } as any

    mockConfig = {
        outerbaseApiKey: 'mock-api-key',
        role: 'admin',
        features: { allowlist: true, rls: true, rest: true },
    }
})

describe('CSV Export Module', () => {
    it('should return a streamed CSV file when table data exists', async () => {
        vi.mocked(exportIndex.executeOperation)
            .mockResolvedValueOnce([{ name: 'users' }])
            .mockResolvedValueOnce([
                { id: 1, name: 'Alice', age: 30 },
                { id: 2, name: 'Bob', age: 25 },
            ])

        const response = await exportTableToCsvRoute(
            'users',
            mockDataSource,
            mockConfig
        )

        expect(response.headers.get('Content-Type')).toBe('text/csv')
        expect(response.headers.get('Content-Disposition')).toBe(
            'attachment; filename="users_export.csv"'
        )
        expect(await response.text()).toBe('id,name,age\n1,Alice,30\n2,Bob,25\n')
    })

    it('should stream large tables across multiple paginated CSV batches', async () => {
        vi.mocked(exportIndex.executeOperation)
            .mockResolvedValueOnce([{ name: 'users' }])
            .mockResolvedValueOnce([
                { id: 1, name: 'Alice', age: 30 },
                { id: 2, name: 'Bob', age: 25 },
            ])
            .mockResolvedValueOnce([
                { id: 3, name: 'Charlie', age: 35 },
                { id: 4, name: 'Diana', age: null },
            ])
            .mockResolvedValueOnce([{ id: 5, name: 'Eve', age: 28 }])

        const response = await exportTableToCsvRoute(
            'users',
            mockDataSource,
            mockConfig,
            { batchSize: 2, breathingIntervalMs: 1 }
        )

        const reader = response.body!.getReader()
        const decoder = new TextDecoder()
        const chunks: string[] = []
        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            chunks.push(decoder.decode(value, { stream: true }))
        }

        expect(chunks).toHaveLength(3)
        expect(chunks.join('')).toBe(
            'id,name,age\n1,Alice,30\n2,Bob,25\n3,Charlie,35\n4,Diana,\n5,Eve,28\n'
        )
        expect(exportIndex.executeOperation).toHaveBeenNthCalledWith(
            2,
            [{ sql: 'SELECT * FROM users LIMIT 2 OFFSET 0;' }],
            mockDataSource,
            mockConfig
        )
        expect(exportIndex.executeOperation).toHaveBeenNthCalledWith(
            3,
            [{ sql: 'SELECT * FROM users LIMIT 2 OFFSET 2;' }],
            mockDataSource,
            mockConfig
        )
        expect(exportIndex.executeOperation).toHaveBeenNthCalledWith(
            4,
            [{ sql: 'SELECT * FROM users LIMIT 2 OFFSET 4;' }],
            mockDataSource,
            mockConfig
        )
    })

    it('should return 404 if table does not exist', async () => {
        vi.mocked(exportIndex.executeOperation).mockResolvedValueOnce([])

        const response = await exportTableToCsvRoute(
            'non_existent_table',
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(404)

        const jsonResponse: { error: string } = await response.json()
        expect(jsonResponse.error).toBe(
            "Table 'non_existent_table' does not exist."
        )
    })

    it('should handle empty table', async () => {
        vi.mocked(exportIndex.executeOperation)
            .mockResolvedValueOnce([{ name: 'empty_table' }])
            .mockResolvedValueOnce([])

        const response = await exportTableToCsvRoute(
            'empty_table',
            mockDataSource,
            mockConfig
        )

        expect(response.headers.get('Content-Type')).toBe('text/csv')
        expect(await response.text()).toBe('')
    })

    it('should escape commas and quotes in CSV values', async () => {
        vi.mocked(exportIndex.executeOperation)
            .mockResolvedValueOnce([{ name: 'special_chars' }])
            .mockResolvedValueOnce([
                { id: 1, name: 'Sahithi, is', bio: 'my forever "penguin"' },
            ])

        const response = await exportTableToCsvRoute(
            'special_chars',
            mockDataSource,
            mockConfig
        )

        expect(response.headers.get('Content-Type')).toBe('text/csv')
        expect(await response.text()).toBe(
            'id,name,bio\n1,"Sahithi, is","my forever ""penguin"""\n'
        )
    })

    it('should return 500 on an unexpected error', async () => {
        const consoleErrorMock = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})
        vi.mocked(exportIndex.executeOperation).mockRejectedValue(
            new Error('Database Error')
        )

        const response = await exportTableToCsvRoute(
            'users',
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(500)
        const jsonResponse: { error: string } = await response.json()
        expect(jsonResponse.error).toBe('Failed to export table to CSV')
        consoleErrorMock.mockRestore()
    })
})
