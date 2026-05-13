import { describe, it, expect, vi, beforeEach } from 'vitest'
import { exportTableToJsonRoute } from './json'
import { getTableDataPage, tableExists } from './index'
import { createResponse } from '../utils'
import type { DataSource } from '../types'
import type { StarbaseDBConfiguration } from '../handler'

vi.mock('./index', () => ({
    EXPORT_PAGE_SIZE: 500,
    getTableDataPage: vi.fn(),
    tableExists: vi.fn(),
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
        vi.mocked(getTableDataPage).mockResolvedValueOnce(mockData)

        const response = await exportTableToJsonRoute(
            'users',
            mockDataSource,
            mockConfig
        )

        expect(response.headers.get('Content-Type')).toBe('application/json')
        expect(response.headers.get('Content-Disposition')).toBe(
            'attachment; filename="users_export.json"'
        )
        await expect(response.json()).resolves.toEqual(mockData)
    })

    it('should return an empty JSON array when table has no data', async () => {
        vi.mocked(tableExists).mockResolvedValue(true)
        vi.mocked(getTableDataPage).mockResolvedValueOnce([])

        const response = await exportTableToJsonRoute(
            'empty_table',
            mockDataSource,
            mockConfig
        )

        expect(response.headers.get('Content-Type')).toBe('application/json')
        await expect(response.json()).resolves.toEqual([])
    })

    it('should escape special characters in JSON properly', async () => {
        const specialCharsData = [
            { id: 1, name: 'Sahithi "The Best"' },
            { id: 2, description: 'New\nLine' },
        ]
        vi.mocked(tableExists).mockResolvedValue(true)
        vi.mocked(getTableDataPage).mockResolvedValueOnce(specialCharsData)

        const response = await exportTableToJsonRoute(
            'special_chars',
            mockDataSource,
            mockConfig
        )

        expect(response.headers.get('Content-Type')).toBe('application/json')
        await expect(response.json()).resolves.toEqual(specialCharsData)
    })

    it('should stream table data in pages instead of loading a full table at once', async () => {
        const firstPage = Array.from({ length: 500 }, (_, index) => ({
            id: index + 1,
        }))
        const secondPage = [{ id: 501 }]
        vi.mocked(tableExists).mockResolvedValue(true)
        vi.mocked(getTableDataPage)
            .mockResolvedValueOnce(firstPage)
            .mockResolvedValueOnce(secondPage)

        const response = await exportTableToJsonRoute(
            'users',
            mockDataSource,
            mockConfig
        )

        await expect(response.json()).resolves.toHaveLength(501)
        expect(getTableDataPage).toHaveBeenCalledWith(
            'users',
            0,
            mockDataSource,
            mockConfig
        )
        expect(getTableDataPage).toHaveBeenCalledWith(
            'users',
            500,
            mockDataSource,
            mockConfig
        )
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
