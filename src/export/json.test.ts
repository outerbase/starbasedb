import { describe, it, expect, vi, beforeEach } from 'vitest'
import { exportTableToJsonRoute } from './json'
import { getTableData, createExportResponse } from './index'
import { createResponse } from '../utils'
import type { DataSource } from '../types'
import type { StarbaseDBConfiguration } from '../handler'

vi.mock('./index', () => ({
    getTableData: vi.fn(),
    createExportResponse: vi.fn(),
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
        vi.mocked(getTableData).mockResolvedValue(null)

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
        vi.mocked(getTableData).mockResolvedValue(mockData)

        vi.mocked(createExportResponse).mockReturnValue(
            new Response('mocked-json-content', {
                headers: { 'Content-Type': 'application/json' },
            })
        )

        const response = await exportTableToJsonRoute(
            'users',
            mockDataSource,
            mockConfig
        )

        expect(getTableData).toHaveBeenCalledWith(
            'users',
            mockDataSource,
            mockConfig
        )
        expect(createExportResponse).toHaveBeenCalledWith(
            JSON.stringify(mockData, null, 4),
            'users_export.json',
            'application/json'
        )
        expect(response.headers.get('Content-Type')).toBe('application/json')
    })

    it('should return an empty JSON array when table has no data', async () => {
        vi.mocked(getTableData).mockResolvedValue([])

        vi.mocked(createExportResponse).mockReturnValue(
            new Response('mocked-json-content', {
                headers: { 'Content-Type': 'application/json' },
            })
        )

        const response = await exportTableToJsonRoute(
            'empty_table',
            mockDataSource,
            mockConfig
        )

        expect(createExportResponse).toHaveBeenCalledWith(
            '[]',
            'empty_table_export.json',
            'application/json'
        )
        expect(response.headers.get('Content-Type')).toBe('application/json')
    })

    it('should escape special characters in JSON properly', async () => {
        const specialCharsData = [
            { id: 1, name: 'Sahithi "The Best"' },
            { id: 2, description: 'New\nLine' },
        ]
        vi.mocked(getTableData).mockResolvedValue(specialCharsData)

        vi.mocked(createExportResponse).mockReturnValue(
            new Response('mocked-json-content', {
                headers: { 'Content-Type': 'application/json' },
            })
        )

        const response = await exportTableToJsonRoute(
            'special_chars',
            mockDataSource,
            mockConfig
        )

        expect(createExportResponse).toHaveBeenCalledWith(
            JSON.stringify(specialCharsData, null, 4),
            'special_chars_export.json',
            'application/json'
        )
        expect(response.headers.get('Content-Type')).toBe('application/json')
    })

    it('should return a 500 response when an error occurs', async () => {
        const consoleErrorMock = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})
        vi.mocked(getTableData).mockRejectedValue(new Error('Database Error'))

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
