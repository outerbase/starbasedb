import { describe, it, expect, vi, beforeEach } from 'vitest'
import { exportTableToJsonRoute } from './json'
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
            new Response('mocked-json-content', {
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

describe('JSON Export Module (streaming)', () => {
    it('should return a streaming JSON response when the table exists', async () => {
        vi.mocked(executeOperation).mockResolvedValueOnce([{ name: 'users' }])
        vi.mocked(getTableDataChunked).mockImplementationOnce(() =>
            mockChunkedGen([[{ id: 1, name: 'Alice' }]])
        )

        const response = await exportTableToJsonRoute(
            'users',
            mockDataSource,
            mockConfig
        )

        expect(response.headers.get('Content-Type')).toBe('application/json')
    })

    it('should return 404 if the table does not exist', async () => {
        vi.mocked(executeOperation).mockResolvedValueOnce([])

        const response = await exportTableToJsonRoute(
            'missing_table',
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(404)
        const jsonResponse = (await response.json()) as { error: string }
        expect(jsonResponse.error).toBe("Table 'missing_table' does not exist.")
    })

    it('should return 500 when an error occurs', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        vi.mocked(executeOperation).mockRejectedValue(
            new Error('Database Error')
        )

        const response = await exportTableToJsonRoute(
            'users',
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(500)
        const jsonResponse = (await response.json()) as { error: string }
        expect(jsonResponse.error).toBe('Failed to export table to JSON')
    })

    it('should pass the correct filename and content-type to createStreamingExportResponse', async () => {
        const { createStreamingExportResponse } = await import('./index')
        vi.mocked(executeOperation).mockResolvedValueOnce([
            { name: 'products' },
        ])
        vi.mocked(getTableDataChunked).mockImplementationOnce(() =>
            mockChunkedGen([])
        )

        await exportTableToJsonRoute('products', mockDataSource, mockConfig)

        expect(createStreamingExportResponse).toHaveBeenCalledWith(
            'products_export.json',
            'application/json',
            expect.any(Object)
        )
    })
})
