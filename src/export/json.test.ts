import { describe, it, expect, vi, beforeEach } from 'vitest'
import { exportTableToJsonRoute } from './json'
import { getTableDataBatches, tableExists } from './index'
import { createResponse } from '../utils'
import type { DataSource } from '../types'
import type { StarbaseDBConfiguration } from '../handler'

function createTestTextStream(
    write: (enqueue: (chunk: string) => void) => Promise<void>
): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder()

    return new ReadableStream<Uint8Array>({
        async start(controller) {
            await write((chunk) => controller.enqueue(encoder.encode(chunk)))
            controller.close()
        },
    })
}

async function* batches(...chunks: any[][]) {
    for (const chunk of chunks) {
        yield chunk
    }
}

vi.mock('./index', () => ({
    tableExists: vi.fn(),
    getTableDataBatches: vi.fn(),
    createTextStream: createTestTextStream,
    createExportStreamResponse: (
        stream: ReadableStream<Uint8Array>,
        fileName: string,
        contentType: string
    ) =>
        new Response(stream, {
            headers: {
                'Content-Type': contentType,
                'Content-Disposition': `attachment; filename="${fileName}"`,
            },
        }),
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

describe('JSON Export Module', () => {
    it('should return a 404 response if table does not exist', async () => {
        vi.mocked(tableExists).mockResolvedValue(false)

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
        vi.mocked(tableExists).mockResolvedValue(true)
        vi.mocked(getTableDataBatches).mockReturnValue(batches(mockData))

        const response = await exportTableToJsonRoute(
            'users',
            mockDataSource,
            mockConfig
        )

        expect(tableExists).toHaveBeenCalledWith(
            'users',
            mockDataSource,
            mockConfig
        )
        expect(getTableDataBatches).toHaveBeenCalledWith(
            'users',
            mockDataSource,
            mockConfig
        )
        expect(response.headers.get('Content-Type')).toBe('application/json')
        expect(await response.json()).toEqual(mockData)
    })

    it('should return an empty JSON array when table has no data', async () => {
        vi.mocked(tableExists).mockResolvedValue(true)
        vi.mocked(getTableDataBatches).mockReturnValue(batches())

        const response = await exportTableToJsonRoute(
            'empty_table',
            mockDataSource,
            mockConfig
        )

        expect(response.headers.get('Content-Type')).toBe('application/json')
        expect(await response.json()).toEqual([])
    })

    it('should escape special characters in JSON properly', async () => {
        const specialCharsData = [
            { id: 1, name: 'Sahithi "The Best"' },
            { id: 2, description: 'New\nLine' },
        ]
        vi.mocked(tableExists).mockResolvedValue(true)
        vi.mocked(getTableDataBatches).mockReturnValue(
            batches(specialCharsData)
        )

        const response = await exportTableToJsonRoute(
            'special_chars',
            mockDataSource,
            mockConfig
        )

        expect(response.headers.get('Content-Type')).toBe('application/json')
        expect(await response.json()).toEqual(specialCharsData)
    })

    it('should stream multiple batches into one JSON array', async () => {
        vi.mocked(tableExists).mockResolvedValue(true)
        vi.mocked(getTableDataBatches).mockReturnValue(
            batches([{ id: 1, name: 'Alice' }], [{ id: 2, name: 'Bob' }])
        )

        const response = await exportTableToJsonRoute(
            'users',
            mockDataSource,
            mockConfig
        )

        expect(await response.json()).toEqual([
            { id: 1, name: 'Alice' },
            { id: 2, name: 'Bob' },
        ])
    })

    it('should return a 500 response when an error occurs', async () => {
        const consoleErrorMock = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})
        vi.mocked(tableExists).mockRejectedValue(new Error('Database Error'))

        const response = await exportTableToJsonRoute(
            'users',
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(500)
        const jsonResponse = (await response.json()) as { error: string }
        expect(jsonResponse.error).toBe('Failed to export table to JSON')
    })
})
