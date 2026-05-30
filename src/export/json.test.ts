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

import { exportTableToJsonRoute } from './json'

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

describe('JSON Export Module', () => {
    it('should return a 404 response if table does not exist', async () => {
        mockExecuteOperation.mockResolvedValueOnce([])

        const response = await exportTableToJsonRoute(
            'missing_table',
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(404)
        const jsonResponse = (await response.json()) as { error: string }
        expect(jsonResponse.error).toBe("Table 'missing_table' does not exist.")
    })

    it('should return a JSON file when table data exists', async () => {
        const mockData = [
            { id: 1, name: 'Alice' },
            { id: 2, name: 'Bob' },
        ]

        // Table exists check
        mockExecuteOperation.mockResolvedValueOnce([{ name: 'users' }])
        // Data chunk
        mockExecuteOperation.mockResolvedValueOnce(mockData)

        const response = await exportTableToJsonRoute(
            'users',
            mockDataSource,
            mockConfig
        )

        expect(response).toBeInstanceOf(Response)
        expect(response.headers.get('Content-Type')).toBe('application/json')

        const jsonText = await response.text()
        const parsed = JSON.parse(jsonText)
        expect(parsed).toEqual(mockData)
    })

    it('should return an empty JSON array when table has no data', async () => {
        // Table exists
        mockExecuteOperation.mockResolvedValueOnce([{ name: 'empty_table' }])
        // Empty data
        mockExecuteOperation.mockResolvedValueOnce([])

        const response = await exportTableToJsonRoute(
            'empty_table',
            mockDataSource,
            mockConfig
        )

        expect(response).toBeInstanceOf(Response)
        const jsonText = await response.text()
        expect(jsonText).toBe('[\n\n]') // Empty array (open bracket + newline + close bracket)
    })

    it('should escape special characters in JSON properly', async () => {
        const specialCharsData = [
            { id: 1, name: 'Sahithi "The Best"' },
            { id: 2, description: 'New\nLine' },
        ]

        // Table exists
        mockExecuteOperation.mockResolvedValueOnce([{ name: 'special_chars' }])
        // Data
        mockExecuteOperation.mockResolvedValueOnce(specialCharsData)

        const response = await exportTableToJsonRoute(
            'special_chars',
            mockDataSource,
            mockConfig
        )

        const jsonText = await response.text()
        const parsed = JSON.parse(jsonText)
        expect(parsed).toEqual(specialCharsData)
    })

    it('should return a 500 response when an error occurs', async () => {
        const consoleErrorMock = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})
        mockExecuteOperation.mockRejectedValue(new Error('Database Error'))

        const response = await exportTableToJsonRoute(
            'users',
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(500)
        const jsonResponse = (await response.json()) as { error: string }
        expect(jsonResponse.error).toBe('Failed to export table to JSON')
        consoleErrorMock.mockRestore()
    })
})
