import { describe, it, expect, vi, beforeEach } from 'vitest'
import { exportTableToJsonRoute } from './json'
import { executeOperation } from '.'
import { createResponse } from '../utils'
import type { DataSource } from '../types'
import type { StarbaseDBConfiguration } from '../handler'

vi.mock('.', () => ({
    executeOperation: vi.fn(),
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

    it('should stream a JSON file when table data exists', async () => {
        const mockData = [
            { id: 1, name: 'Alice' },
            { id: 2, name: 'Bob' },
        ]

        vi.mocked(executeOperation)
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
        await expect(response.json()).resolves.toEqual(mockData)
    })

    it('should return an empty JSON array when table has no data', async () => {
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'empty_table' }])
            .mockResolvedValueOnce([])

        const response = await exportTableToJsonRoute(
            'empty_table',
            mockDataSource,
            mockConfig
        )

        await expect(response.json()).resolves.toEqual([])
    })

    it('should escape special characters in JSON properly', async () => {
        const specialCharsData = [
            { id: 1, name: 'Sahithi "The Best"' },
            { id: 2, description: 'New\nLine' },
        ]

        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'special_chars' }])
            .mockResolvedValueOnce(specialCharsData)

        const response = await exportTableToJsonRoute(
            'special_chars',
            mockDataSource,
            mockConfig
        )

        await expect(response.json()).resolves.toEqual(specialCharsData)
    })

    it('should page table data instead of loading the full table', async () => {
        const firstPage = Array.from({ length: 1000 }, (_, index) => ({
            id: index + 1,
        }))

        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'users' }])
            .mockResolvedValueOnce(firstPage)
            .mockResolvedValueOnce([{ id: 1001 }])

        const response = await exportTableToJsonRoute(
            'users',
            mockDataSource,
            mockConfig
        )

        await expect(response.json()).resolves.toHaveLength(1001)
        expect(executeOperation).toHaveBeenNthCalledWith(
            2,
            [
                {
                    sql: 'SELECT * FROM "users" LIMIT ? OFFSET ?;',
                    params: [1000, 0],
                },
            ],
            mockDataSource,
            mockConfig
        )
        expect(executeOperation).toHaveBeenNthCalledWith(
            3,
            [
                {
                    sql: 'SELECT * FROM "users" LIMIT ? OFFSET ?;',
                    params: [1000, 1000],
                },
            ],
            mockDataSource,
            mockConfig
        )
    })

    it('should return a 500 response when an error occurs before streaming starts', async () => {
        const consoleErrorMock = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})
        vi.mocked(executeOperation).mockRejectedValue(new Error('Database Error'))

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
