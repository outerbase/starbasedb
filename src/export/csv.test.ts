import { describe, it, expect, vi, beforeEach } from 'vitest'
import { exportTableToCsvRoute } from './csv'
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
    it('should return a CSV file when table data exists', async () => {
        vi.mocked(tableExists).mockResolvedValue(true)
        vi.mocked(getTableDataBatches).mockReturnValue(
            batches([
                { id: 1, name: 'Alice', age: 30 },
                { id: 2, name: 'Bob', age: 25 },
            ])
        )

        const response = await exportTableToCsvRoute(
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
        expect(response.headers.get('Content-Type')).toBe('text/csv')
        expect(await response.text()).toBe(
            'id,name,age\n1,Alice,30\n2,Bob,25\n'
        )
    })

    it('should return 404 if table does not exist', async () => {
        vi.mocked(tableExists).mockResolvedValue(false)

        const response = await exportTableToCsvRoute(
            'non_existent_table',
            mockDataSource,
            mockConfig
        )

        expect(tableExists).toHaveBeenCalledWith(
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

    it('should handle empty table (return only headers)', async () => {
        vi.mocked(tableExists).mockResolvedValue(true)
        vi.mocked(getTableDataBatches).mockReturnValue(batches())

        const response = await exportTableToCsvRoute(
            'empty_table',
            mockDataSource,
            mockConfig
        )

        expect(tableExists).toHaveBeenCalledWith(
            'empty_table',
            mockDataSource,
            mockConfig
        )
        expect(response.headers.get('Content-Type')).toBe('text/csv')
        expect(await response.text()).toBe('')
    })

    it('should escape commas and quotes in CSV values', async () => {
        vi.mocked(tableExists).mockResolvedValue(true)
        vi.mocked(getTableDataBatches).mockReturnValue(
            batches([
                { id: 1, name: 'Sahithi, is', bio: 'my forever "penguin"' },
            ])
        )

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

    it('should stream multiple batches into one CSV file', async () => {
        vi.mocked(tableExists).mockResolvedValue(true)
        vi.mocked(getTableDataBatches).mockReturnValue(
            batches([{ id: 1, name: 'Alice' }], [{ id: 2, name: 'Bob' }])
        )

        const response = await exportTableToCsvRoute(
            'users',
            mockDataSource,
            mockConfig
        )

        expect(await response.text()).toBe('id,name\n1,Alice\n2,Bob\n')
    })

    it('should return 500 on an unexpected error', async () => {
        const consoleErrorMock = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})
        vi.mocked(tableExists).mockRejectedValue(new Error('Database Error'))

        const response = await exportTableToCsvRoute(
            'users',
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(500)
        const jsonResponse: { error: string } = await response.json()
        expect(jsonResponse.error).toBe('Failed to export table to CSV')
    })
})
