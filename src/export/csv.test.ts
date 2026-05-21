import { describe, it, expect, vi, beforeEach } from 'vitest'
import { exportTableToCsvRoute } from './csv'
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
        vi.mocked(executeTransaction)
            .mockResolvedValueOnce([[{ name: 'users' }]])
            .mockResolvedValueOnce([
                [{ name: 'id' }, { name: 'name' }, { name: 'age' }],
            ])
            .mockResolvedValueOnce([
                [
                    { id: 1, name: 'Alice', age: 30 },
                    { id: 2, name: 'Bob', age: 25 },
                ],
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
        expect(await response.text()).toBe(
            'id,name,age\n1,Alice,30\n2,Bob,25\n'
        )
    })

    it('should return 404 if table does not exist', async () => {
        vi.mocked(executeTransaction).mockResolvedValueOnce([[]])

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

    it('should include headers when an existing table has no rows', async () => {
        vi.mocked(executeTransaction)
            .mockResolvedValueOnce([[{ name: 'empty_table' }]])
            .mockResolvedValueOnce([[{ name: 'id' }, { name: 'name' }]])
            .mockResolvedValueOnce([[]])

        const response = await exportTableToCsvRoute(
            'empty_table',
            mockDataSource,
            mockConfig
        )

        expect(await response.text()).toBe('id,name\n')
    })

    it('should escape commas, quotes, and new lines in CSV values', async () => {
        vi.mocked(executeTransaction)
            .mockResolvedValueOnce([[{ name: 'special_chars' }]])
            .mockResolvedValueOnce([
                [{ name: 'id' }, { name: 'name' }, { name: 'bio' }],
            ])
            .mockResolvedValueOnce([
                [
                    {
                        id: 1,
                        name: 'Sahithi, is',
                        bio: 'line one\nwith a "quote"',
                    },
                ],
            ])

        const response = await exportTableToCsvRoute(
            'special_chars',
            mockDataSource,
            mockConfig
        )

        expect(await response.text()).toBe(
            'id,name,bio\n1,"Sahithi, is","line one\nwith a ""quote"""\n'
        )
    })

    it('should page additional CSV rows only as the stream is read', async () => {
        vi.mocked(executeTransaction)
            .mockResolvedValueOnce([[{ name: 'users' }]])
            .mockResolvedValueOnce([[{ name: 'id' }, { name: 'name' }]])
            .mockResolvedValueOnce([[{ id: 1, name: 'Alice' }]])
            .mockResolvedValueOnce([[{ id: 2, name: 'Bob' }]])
            .mockResolvedValueOnce([[]])

        const response = await exportTableToCsvRoute(
            'users',
            mockDataSource,
            mockConfig,
            { batchSize: 1 }
        )

        expect(executeTransaction).toHaveBeenCalledTimes(3)
        expect(await response.text()).toBe('id,name\n1,Alice\n2,Bob\n')
        expect(executeTransaction).toHaveBeenCalledTimes(5)
        expect(vi.mocked(executeTransaction).mock.calls[3][0].queries).toEqual([
            {
                sql: 'SELECT * FROM "users" LIMIT ? OFFSET ?;',
                params: [1, 1],
            },
        ])
    })

    it('should return 500 on an unexpected error before streaming', async () => {
        const consoleErrorMock = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})
        vi.mocked(executeTransaction).mockRejectedValue(
            new Error('Database Error')
        )

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
