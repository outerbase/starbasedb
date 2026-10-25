import { describe, it, expect, vi, beforeEach } from 'vitest'
import { exportTableToJsonRoute } from './json'
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
        rpc: { executeQuery: vi.fn() },
    } as any

    mockConfig = {
        outerbaseApiKey: '[REDACTED:auth_header]',
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

    it('should return a JSON file when table data exists', async () => {
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

        expect(response.status).toBe(200)
        expect(response.headers.get('Content-Type')).toBe('application/json')
        expect(response.headers.get('Content-Disposition')).toBe(
            'attachment; filename="users_export.json"'
        )

        const jsonText = await response.text()
        expect(JSON.parse(jsonText)).toEqual(mockData)
        expect(jsonText).toBe(JSON.stringify(mockData, null, 4))
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

        expect(response.status).toBe(200)
        expect(response.headers.get('Content-Type')).toBe('application/json')
        expect(response.headers.get('Content-Disposition')).toBe(
            'attachment; filename="empty_table_export.json"'
        )

        const jsonText = await response.text()
        expect(jsonText).toBe('[]')
    })

    it('should escape special characters in JSON properly', async () => {
        const specialCharsData = [
            { id: 1, text: 'Hello "World"\nNew line\tTab \\ Backslash' },
        ]
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'special_chars' }])
            .mockResolvedValueOnce(specialCharsData)

        const response = await exportTableToJsonRoute(
            'special_chars',
            mockDataSource,
            mockConfig
        )

        expect(response.headers.get('Content-Type')).toBe('application/json')
        const jsonText = await response.text()
        expect(JSON.parse(jsonText)).toEqual(specialCharsData)
        expect(jsonText).toBe(JSON.stringify(specialCharsData, null, 4))
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

        const response = await exportTableToJsonRoute(
            'users',
            mockDataSource,
            mockConfig
        )

        const jsonText = await response.text()
        const parsed = JSON.parse(jsonText)
        expect(parsed).toHaveLength(1001)
        expect(parsed[0]).toEqual({ id: 1, name: 'User1' })
        expect(parsed[1000]).toEqual({ id: 1001, name: 'User1001' })

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

        const response = await exportTableToJsonRoute(
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
        const parsed = JSON.parse(combined)
        expect(parsed).toHaveLength(1001)
    })

    it('should return a 500 response when an error occurs', async () => {
        const consoleErrorMock = vi
            .spyOn(console, 'error')
            .mockImplementation(() => {})
        vi.mocked(executeOperation).mockRejectedValue(
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
    })
})
