import { describe, it, expect, vi, beforeEach } from 'vitest'
import { exportTableToCsvRoute } from './csv'
import { executeOperation, getTableDataChunked } from './index'
import { createResponse } from '../utils'
import type { DataSource } from '../types'
import type { StarbaseDBConfiguration } from '../handler'

vi.mock('./index', () => ({
    executeOperation: vi.fn(),
    getTableDataChunked: vi.fn(),
    createStreamingExportResponse: vi.fn(
        (
            _fileName: string,
            contentType: string,
            _gen: AsyncGenerator<string>
        ) =>
            new Response('mocked-csv-content', {
                headers: { 'Content-Type': contentType },
            })
    ),
    createExportResponse: vi.fn(),
}))

vi.mock('../utils', () => ({
    createResponse: vi.fn(
        (data: any, message: string, status: number) =>
            new Response(JSON.stringify({ result: data, error: message }), {
                status,
                headers: { 'Content-Type': 'application/json' },
            })
    ),
}))

/**
 * Helper: build a mock async generator that yields pre-defined chunks.
 */
async function* mockChunkedGen(rows: any[][]): AsyncGenerator<any[]> {
    for (const chunk of rows) {
        yield chunk
    }
}

let mockDataSource: DataSource
let mockConfig: StarbaseDBConfiguration

beforeEach(() => {
    vi.clearAllMocks()

    mockDataSource = {
        source: 'internal',
        rpc: { executeQuery: vi.fn() },
    } as any

    mockConfig = {
        outerbaseApiKey: 'mock-api-key',
        role: 'admin',
        features: { allowlist: true, rls: true, rest: true },
    }
})

describe('CSV Export Module (streaming)', () => {
    it('should return a streaming CSV response when the table exists', async () => {
        vi.mocked(executeOperation).mockResolvedValueOnce([{ name: 'users' }])
        vi.mocked(getTableDataChunked).mockImplementationOnce(() =>
            mockChunkedGen([[{ id: 1, name: 'Alice', age: 30 }]])
        )

        const response = await exportTableToCsvRoute(
            'users',
            mockDataSource,
            mockConfig
        )

        expect(response.headers.get('Content-Type')).toBe('text/csv')
    })

    it('should return 404 if the table does not exist', async () => {
        vi.mocked(executeOperation).mockResolvedValueOnce([])

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

    it('should return 500 on an unexpected error', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        vi.mocked(executeOperation).mockRejectedValue(
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
    })

    it('should pass the correct filename and content-type to createStreamingExportResponse', async () => {
        const { createStreamingExportResponse } = await import('./index')
        vi.mocked(executeOperation).mockResolvedValueOnce([{ name: 'sales' }])
        vi.mocked(getTableDataChunked).mockImplementationOnce(() =>
            mockChunkedGen([])
        )

        await exportTableToCsvRoute('sales', mockDataSource, mockConfig)

        expect(createStreamingExportResponse).toHaveBeenCalledWith(
            'sales_export.csv',
            'text/csv',
            expect.any(Object)
        )
    })
})
