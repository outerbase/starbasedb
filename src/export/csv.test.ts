import { describe, it, expect, vi, beforeEach } from 'vitest'
import { exportTableToCsvRoute } from './csv'
import { executeOperation } from './index'
import { createResponse } from '../utils'
import type { DataSource } from '../types'
import type { StarbaseDBConfiguration } from '../handler'

vi.mock('./index', () => ({
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

const tableColumns = (names: string[]) =>
    names.map((name, index) => ({
        cid: index,
        name,
        type: '',
        notnull: 0,
        dflt_value: null,
        pk: name === 'id' ? 1 : 0,
    }))

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
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'users' }])
            .mockResolvedValueOnce(tableColumns(['id', 'name', 'age']))
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

    it('should handle empty table (return only headers)', async () => {
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'empty_table' }])
            .mockResolvedValueOnce(tableColumns(['id', 'name']))
            .mockResolvedValueOnce([])

        const response = await exportTableToCsvRoute(
            'empty_table',
            mockDataSource,
            mockConfig
        )

        expect(response.headers.get('Content-Type')).toBe('text/csv')
        await expect(response.text()).resolves.toBe('id,name\n')
    })

    it('should escape commas and quotes in CSV values', async () => {
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'special_chars' }])
            .mockResolvedValueOnce(tableColumns(['id', 'name', 'bio']))
            .mockResolvedValueOnce([
                { id: 1, name: 'Sahithi, is', bio: 'my forever "penguin"' },
            ])

        const response = await exportTableToCsvRoute(
            'special_chars',
            mockDataSource,
            mockConfig
        )

        await expect(response.text()).resolves.toBe(
            'id,name,bio\n1,"Sahithi, is","my forever ""penguin"""\n'
        )
        expect(response.headers.get('Content-Type')).toBe('text/csv')
    })

    it('should return 500 on an unexpected error', async () => {
        const consoleErrorMock = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})
        vi.mocked(executeOperation).mockRejectedValue(
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
    })
})
