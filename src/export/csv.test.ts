import { describe, it, expect, vi, beforeEach } from 'vitest'
import { exportTableToCsvRoute } from './csv'
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
        vi.mocked(getTableData).mockResolvedValue([
            { id: 1, name: 'Alice', age: 30 },
            { id: 2, name: 'Bob', age: 25 },
        ])

        vi.mocked(createExportResponse).mockReturnValue(
            new Response('mocked-csv-content', {
                headers: { 'Content-Type': 'text/csv' },
            })
        )

        const response = await exportTableToCsvRoute(
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
            'id,name,age\n1,Alice,30\n2,Bob,25\n',
            'users_export.csv',
            'text/csv'
        )
        expect(response.headers.get('Content-Type')).toBe('text/csv')
    })

    it('should return 404 if table does not exist', async () => {
        vi.mocked(getTableData).mockResolvedValue(null)

        const response = await exportTableToCsvRoute(
            'non_existent_table',
            mockDataSource,
            mockConfig
        )

        expect(getTableData).toHaveBeenCalledWith(
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
        vi.mocked(getTableData).mockResolvedValue([])

        vi.mocked(createExportResponse).mockReturnValue(
            new Response('mocked-csv-content', {
                headers: { 'Content-Type': 'text/csv' },
            })
        )

        const response = await exportTableToCsvRoute(
            'empty_table',
            mockDataSource,
            mockConfig
        )

        expect(getTableData).toHaveBeenCalledWith(
            'empty_table',
            mockDataSource,
            mockConfig
        )
        expect(createExportResponse).toHaveBeenCalledWith(
            '',
            'empty_table_export.csv',
            'text/csv'
        )
        expect(response.headers.get('Content-Type')).toBe('text/csv')
    })

    it('should escape commas and quotes in CSV values', async () => {
        vi.mocked(getTableData).mockResolvedValue([
            { id: 1, name: 'Sahithi, is', bio: 'my forever "penguin"' },
        ])

        vi.mocked(createExportResponse).mockReturnValue(
            new Response('mocked-csv-content', {
                headers: { 'Content-Type': 'text/csv' },
            })
        )

        const response = await exportTableToCsvRoute(
            'special_chars',
            mockDataSource,
            mockConfig
        )

        expect(createExportResponse).toHaveBeenCalledWith(
            'id,name,bio\n1,"Sahithi, is","my forever ""penguin"""\n',
            'special_chars_export.csv',
            'text/csv'
        )
        expect(response.headers.get('Content-Type')).toBe('text/csv')
    })

    it('should return 500 on an unexpected error', async () => {
        const consoleErrorMock = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})
        vi.mocked(getTableData).mockRejectedValue(new Error('Database Error'))

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
