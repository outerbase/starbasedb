import { describe, it, expect, vi, beforeEach } from 'vitest'
import { exportTableToCsvRoute } from './csv'
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
    it('should stream a CSV file when table data exists', async () => {
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'users' }])
            .mockResolvedValueOnce([
                { name: 'id' },
                { name: 'name' },
                { name: 'age' },
            ])
            .mockResolvedValueOnce([
                { id: 1, name: 'Alice', age: 30 },
                { id: 2, name: 'Bob', age: 25 },
            ])

        const response = await exportTableToCsvRoute(
            'users',
            mockDataSource,
            mockConfig
        )

        expect(response.headers.get('Content-Type')).toBe('text/csv')
        expect(response.headers.get('Content-Disposition')).toBe(
            'attachment; filename="users_export.csv"'
        )
        await expect(response.text()).resolves.toBe(
            'id,name,age\n1,Alice,30\n2,Bob,25\n'
        )
    })

    it('should return 404 if table does not exist', async () => {
        vi.mocked(executeOperation).mockResolvedValueOnce([])

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

    it('should include headers for empty tables', async () => {
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'empty_table' }])
            .mockResolvedValueOnce([{ name: 'id' }, { name: 'name' }])
            .mockResolvedValueOnce([])

        const response = await exportTableToCsvRoute(
            'empty_table',
            mockDataSource,
            mockConfig
        )

        await expect(response.text()).resolves.toBe('id,name\n')
    })

    it('should escape commas, quotes, and newlines in CSV values', async () => {
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'special_chars' }])
            .mockResolvedValueOnce([
                { name: 'id' },
                { name: 'name' },
                { name: 'bio' },
            ])
            .mockResolvedValueOnce([
                {
                    id: 1,
                    name: 'Sahithi, is',
                    bio: 'my forever "penguin"\nline',
                },
            ])

        const response = await exportTableToCsvRoute(
            'special_chars',
            mockDataSource,
            mockConfig
        )

        await expect(response.text()).resolves.toBe(
            'id,name,bio\n1,"Sahithi, is","my forever ""penguin""\nline"\n'
        )
    })

    it('should page table data instead of loading the full table', async () => {
        const firstPage = Array.from({ length: 1000 }, (_, index) => ({
            id: index + 1,
            name: `User ${index + 1}`,
        }))

        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'users' }])
            .mockResolvedValueOnce([{ name: 'id' }, { name: 'name' }])
            .mockResolvedValueOnce(firstPage)
            .mockResolvedValueOnce([{ id: 1001, name: 'Last User' }])

        const response = await exportTableToCsvRoute(
            'users',
            mockDataSource,
            mockConfig
        )

        const csv = await response.text()

        expect(csv).toContain('1001,Last User\n')
        expect(executeOperation).toHaveBeenNthCalledWith(
            3,
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
            4,
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

    it('should return 500 on an unexpected error before streaming starts', async () => {
        const consoleErrorMock = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})
        vi.mocked(executeOperation).mockRejectedValue(new Error('Database Error'))

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
