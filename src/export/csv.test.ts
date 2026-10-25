import { describe, it, expect, vi, beforeEach } from 'vitest'
import { exportTableToCsvRoute } from './csv'
import { executeOperation } from './index'
import type * as IndexModule from './index'
import type { DataSource } from '../types'
import type { StarbaseDBConfiguration } from '../handler'

vi.mock('./index', async () => {
    const actual = await vi.importActual<typeof IndexModule>('./index')
    return {
        ...actual,
        executeOperation: vi.fn(),
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

        const csvText = await response.text()
        expect(csvText).toBe('id,name,age\n1,Alice,30\n2,Bob,25\n')
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

    it('should handle empty table (return empty content)', async () => {
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'empty_table' }])
            .mockResolvedValueOnce([])

        const response = await exportTableToCsvRoute(
            'empty_table',
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(200)
        expect(response.headers.get('Content-Type')).toBe('text/csv')
        expect(response.headers.get('Content-Disposition')).toBe(
            'attachment; filename="empty_table_export.csv"'
        )

        const csvText = await response.text()
        expect(csvText).toBe('')
    })

    it('should escape commas and quotes in CSV values', async () => {
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'special_chars' }])
            .mockResolvedValueOnce([
                { id: 1, name: 'Sahithi, is', bio: 'my forever "penguin"' },
            ])

        const response = await exportTableToCsvRoute(
            'special_chars',
            mockDataSource,
            mockConfig
        )

        expect(response.headers.get('Content-Type')).toBe('text/csv')
        const csvText = await response.text()
        expect(csvText).toBe(
            'id,name,bio\n1,"Sahithi, is","my forever ""penguin"""\n'
        )
    })

    it('should paginate large tables across multiple queries', async () => {
        const firstPage = Array.from({ length: 1000 }, (_, i) => ({
            id: i + 1,
            name: `User${i + 1}`,
        }))
        const secondPage = [{ id: 1001, name: 'User1001' }]

        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'users' }])
            .mockResolvedValueOnce(firstPage)
            .mockResolvedValueOnce(secondPage)

        const response = await exportTableToCsvRoute(
            'users',
            mockDataSource,
            mockConfig
        )

        const csvText = await response.text()
        expect(csvText).toContain('id,name\n')
        expect(csvText).toContain('1,User1\n')
        expect(csvText).toContain('1000,User1000\n')
        expect(csvText).toContain('1001,User1001\n')

        const issuedSql = vi
            .mocked(executeOperation)
            .mock.calls.map((c) => (c[0] as Array<{ sql: string }>)[0].sql)
        expect(issuedSql).toContain('SELECT * FROM users LIMIT 1000 OFFSET 0;')
        expect(issuedSql).toContain(
            'SELECT * FROM users LIMIT 1000 OFFSET 1000;'
        )
    })

    it('should stream chunks incrementally without buffering entire dataset', async () => {
        const page1 = Array.from({ length: 1000 }, (_, i) => ({
            id: i + 1,
            name: `User${i + 1}`,
        }))
        const page2 = [{ id: 1001, name: 'User1001' }]

        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'users' }])
            .mockResolvedValueOnce(page1)
            .mockResolvedValueOnce(page2)

        const response = await exportTableToCsvRoute(
            'users',
            mockDataSource,
            mockConfig
        )

        expect(response.body).toBeInstanceOf(ReadableStream)
        const reader = response.body!.getReader()
        const decoder = new TextDecoder()
        let receivedChunks = 0
        let combined = ''

        while (true) {
            const { done, value } = await reader.read()
            if (done) break
            receivedChunks++
            combined += decoder.decode(value, { stream: true })
        }

        expect(receivedChunks).toBeGreaterThan(0)
        expect(combined).toContain('id,name\n1,User1\n')
        expect(combined).toContain('1001,User1001\n')
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
