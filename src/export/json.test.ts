import { describe, it, expect, vi, beforeEach } from 'vitest'
import { exportTableToJsonRoute } from './json'
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
        vi.mocked(exportIndex.executeOperation).mockResolvedValueOnce([])

        const response = await exportTableToJsonRoute(
            'missing_table',
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(404)
        const jsonResponse = (await response.json()) as { error: string }
        expect(jsonResponse.error).toBe("Table 'missing_table' does not exist.")
    })

    it('should return a streamed JSON file when table data exists', async () => {
        const mockData = [
            { id: 1, name: 'Alice' },
            { id: 2, name: 'Bob' },
        ]
        vi.mocked(exportIndex.executeOperation)
            .mockResolvedValueOnce([{ name: 'users' }])
            .mockResolvedValueOnce(mockData)

        const response = await exportTableToJsonRoute(
            'users',
            mockDataSource,
            mockConfig
        )

        expect(response.headers.get('Content-Type')).toBe('application/json')
        expect(response.headers.get('Content-Disposition')).toBe(
            'attachment; filename="users_export.json"'
        )
        expect(await response.text()).toBe(JSON.stringify(mockData, null, 4))
    })

    it('should stream large tables across multiple paginated JSON batches', async () => {
        const batch1 = [
            { id: 1, name: 'Alice' },
            { id: 2, name: 'Bob' },
        ]
        const batch2 = [
            { id: 3, name: 'Charlie' },
            { id: 4, name: 'Diana' },
        ]
        const batch3 = [{ id: 5, name: 'Eve' }]

        vi.mocked(exportIndex.executeOperation)
            .mockResolvedValueOnce([{ name: 'users' }])
            .mockResolvedValueOnce(batch1)
            .mockResolvedValueOnce(batch2)
            .mockResolvedValueOnce(batch3)

        const response = await exportTableToJsonRoute(
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

        expect(chunks).toHaveLength(4) // 3 data batches + closing bracket
        const fullJson = chunks.join('')
        expect(fullJson).toBe(
            JSON.stringify([...batch1, ...batch2, ...batch3], null, 4)
        )
        expect(JSON.parse(fullJson)).toEqual([
            ...batch1,
            ...batch2,
            ...batch3,
        ])
    })

    it('should return an empty JSON array when table has no data', async () => {
        vi.mocked(exportIndex.executeOperation)
            .mockResolvedValueOnce([{ name: 'empty_table' }])
            .mockResolvedValueOnce([])

        const response = await exportTableToJsonRoute(
            'empty_table',
            mockDataSource,
            mockConfig
        )

        expect(response.headers.get('Content-Type')).toBe('application/json')
        expect(await response.text()).toBe('[]')
    })

    it('should escape special characters in JSON properly', async () => {
        const specialCharsData = [
            { id: 1, name: 'Sahithi "The Best"' },
            { id: 2, description: 'New\nLine' },
        ]
        vi.mocked(exportIndex.executeOperation)
            .mockResolvedValueOnce([{ name: 'special_chars' }])
            .mockResolvedValueOnce(specialCharsData)

        const response = await exportTableToJsonRoute(
            'special_chars',
            mockDataSource,
            mockConfig
        )

        expect(response.headers.get('Content-Type')).toBe('application/json')
        expect(await response.text()).toBe(
            JSON.stringify(specialCharsData, null, 4)
        )
    })

    it('should return a 500 response when an error occurs', async () => {
        const consoleErrorMock = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})
        vi.mocked(exportIndex.executeOperation).mockRejectedValue(
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
        consoleErrorMock.mockRestore()
    })
})
