import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DataSource } from '../types'
import type { StarbaseDBConfiguration } from '../handler'

const mockExecuteOperation = vi.fn()

vi.mock('./index', () => ({
    executeOperation: (...args: any[]) => mockExecuteOperation(...args),
    getTableDataChunked: async function* (
        tableName: string,
        dataSource: any,
        config: any,
        chunkSize: number = 1000
    ) {
        let offset = 0
        while (true) {
            const chunk = await mockExecuteOperation(
                [{ sql: `SELECT * FROM ${tableName} LIMIT ? OFFSET ?;`, params: [chunkSize, offset] }],
                dataSource,
                config
            )
            if (!chunk || chunk.length === 0) break
            yield chunk
            if (chunk.length < chunkSize) break
            offset += chunkSize
        }
    },
    createStreamingExportResponse: (
        producer: any,
        fileName: string,
        contentType: string
    ) => {
        const { readable, writable } = new TransformStream()
        const writer = writable.getWriter()

        const done = (async () => {
            try {
                await producer(writer)
            } finally {
                await writer.close()
            }
        })()

        const response = new Response(readable, {
            headers: {
                'Content-Type': contentType,
                'Content-Disposition': `attachment; filename="${fileName}"`,
            },
        })
        ;(response as any).__producerDone = done
        return response
    },
    writeChunk: async (writer: WritableStreamDefaultWriter, content: string) => {
        await writer.write(new TextEncoder().encode(content))
    },
    createExportResponse: (data: any, fileName: string, contentType: string) => {
        const blob = new Blob([data], { type: contentType })
        return new Response(blob, {
            headers: {
                'Content-Type': contentType,
                'Content-Disposition': `attachment; filename="${fileName}"`,
            },
        })
    },
    getTableData: vi.fn(),
}))

vi.mock('../utils', () => ({
    createResponse: vi.fn(
        (data: any, message: any, status: any) =>
            new Response(JSON.stringify({ result: data, error: message }), {
                status,
                headers: { 'Content-Type': 'application/json' },
            })
    ),
}))

import { exportTableToCsvRoute } from './csv'

let mockDataSource: DataSource
let mockConfig: StarbaseDBConfiguration

beforeEach(() => {
    vi.clearAllMocks()
    mockExecuteOperation.mockReset()

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

describe('CSV Export Module', () => {
    it('should return a CSV file when table data exists', async () => {
        // Table exists check
        mockExecuteOperation.mockResolvedValueOnce([{ name: 'users' }])
        // Data chunk
        mockExecuteOperation.mockResolvedValueOnce([
            { id: 1, name: 'Alice', age: 30 },
            { id: 2, name: 'Bob', age: 25 },
        ])

        const response = await exportTableToCsvRoute(
            'users',
            mockDataSource,
            mockConfig
        )

        expect(response).toBeInstanceOf(Response)
        expect(response.headers.get('Content-Type')).toBe('text/csv')

        const csvText = await response.text()
        expect(csvText).toContain('id,name,age')
        expect(csvText).toContain('1,Alice,30')
        expect(csvText).toContain('2,Bob,25')
    })

    it('should return 404 if table does not exist', async () => {
        mockExecuteOperation.mockResolvedValueOnce([])

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

    it('should handle empty table (no output)', async () => {
        // Table exists
        mockExecuteOperation.mockResolvedValueOnce([{ name: 'empty_table' }])
        // Empty data
        mockExecuteOperation.mockResolvedValueOnce([])

        const response = await exportTableToCsvRoute(
            'empty_table',
            mockDataSource,
            mockConfig
        )

        expect(response).toBeInstanceOf(Response)
        expect(response.headers.get('Content-Type')).toBe('text/csv')

        const csvText = await response.text()
        expect(csvText).toBe('') // No headers, no data
    })

    it('should escape commas and quotes in CSV values', async () => {
        // Table exists
        mockExecuteOperation.mockResolvedValueOnce([{ name: 'special_chars' }])
        // Data with special chars
        mockExecuteOperation.mockResolvedValueOnce([
            { id: 1, name: 'Sahithi, is', bio: 'my forever "penguin"' },
        ])

        const response = await exportTableToCsvRoute(
            'special_chars',
            mockDataSource,
            mockConfig
        )

        const csvText = await response.text()
        expect(csvText).toContain('id,name,bio')
        expect(csvText).toContain('1,"Sahithi, is","my forever ""penguin"""')
    })

    it('should return 500 on an unexpected error', async () => {
        const consoleErrorMock = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})
        mockExecuteOperation.mockRejectedValue(new Error('Database Error'))

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
