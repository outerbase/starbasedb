import { describe, it, expect, vi, beforeEach } from 'vitest'
import { exportTableToJsonRoute } from './json'
import { executeTransaction } from '../operation'
import type { DataSource } from '../types'
import type { StarbaseDBConfiguration } from '../handler'

vi.mock('../operation', () => ({
    executeTransaction: vi.fn(),
}))

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

describe('JSON Export Module', () => {
    it('should return a 404 response if table does not exist', async () => {
        vi.mocked(executeTransaction).mockResolvedValueOnce([[]])

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
        vi.mocked(executeTransaction)
            .mockResolvedValueOnce([[{ name: 'users' }]])
            .mockResolvedValueOnce([
                [
                    { id: 1, name: 'Alice' },
                    { id: 2, name: 'Bob' },
                ],
            ])

        const response = await exportTableToJsonRoute(
            'users',
            mockDataSource,
            mockConfig
        )

        expect(response.headers.get('Content-Type')).toBe('application/json')
        expect(response.headers.get('Content-Disposition')).toBe(
            'attachment; filename="users_export.json"'
        )

        const jsonResponse = JSON.parse(await response.text())
        expect(jsonResponse).toEqual([
            { id: 1, name: 'Alice' },
            { id: 2, name: 'Bob' },
        ])
    })

    it('should return an empty JSON array when table has no data', async () => {
        vi.mocked(executeTransaction)
            .mockResolvedValueOnce([[{ name: 'empty_table' }]])
            .mockResolvedValueOnce([[]])

        const response = await exportTableToJsonRoute(
            'empty_table',
            mockDataSource,
            mockConfig
        )

        expect(await response.text()).toBe('[]')
    })

    it('should page additional JSON rows only as the stream is read', async () => {
        vi.mocked(executeTransaction)
            .mockResolvedValueOnce([[{ name: 'users' }]])
            .mockResolvedValueOnce([[{ id: 1, name: 'Alice' }]])
            .mockResolvedValueOnce([[{ id: 2, name: 'Bob' }]])
            .mockResolvedValueOnce([[]])

        const response = await exportTableToJsonRoute(
            'users',
            mockDataSource,
            mockConfig,
            { batchSize: 1 }
        )

        expect(executeTransaction).toHaveBeenCalledTimes(2)

        const jsonResponse = JSON.parse(await response.text())

        expect(jsonResponse).toEqual([
            { id: 1, name: 'Alice' },
            { id: 2, name: 'Bob' },
        ])
        expect(executeTransaction).toHaveBeenCalledTimes(4)
        expect(vi.mocked(executeTransaction).mock.calls[2][0].queries).toEqual([
            {
                sql: 'SELECT * FROM "users" LIMIT ? OFFSET ?;',
                params: [1, 1],
            },
        ])
        expect(vi.mocked(executeTransaction).mock.calls[3][0].queries).toEqual([
            {
                sql: 'SELECT * FROM "users" LIMIT ? OFFSET ?;',
                params: [1, 2],
            },
        ])
    })

    it('should escape special characters in JSON properly', async () => {
        const specialCharsData = [
            { id: 1, name: 'Sahithi "The Best"' },
            { id: 2, description: 'New\nLine' },
        ]

        vi.mocked(executeTransaction)
            .mockResolvedValueOnce([[{ name: 'special_chars' }]])
            .mockResolvedValueOnce([specialCharsData])

        const response = await exportTableToJsonRoute(
            'special_chars',
            mockDataSource,
            mockConfig
        )

        expect(JSON.parse(await response.text())).toEqual(specialCharsData)
    })

    it('should return a 500 response when an error occurs before streaming', async () => {
        const consoleErrorMock = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})
        vi.mocked(executeTransaction).mockRejectedValue(
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
