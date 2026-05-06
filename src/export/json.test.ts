import { describe, it, expect, vi, beforeEach } from 'vitest'
import { exportTableToJsonRoute } from './json'
import { executeOperation } from './index'
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

beforeEach(() => {
    vi.mocked(executeOperation).mockReset()

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

function mockTable(rows: any[]) {
    vi.mocked(executeOperation)
        .mockResolvedValueOnce([{ name: 'tbl' }])
        .mockResolvedValueOnce(rows)
        .mockResolvedValueOnce([])
}

describe('JSON Export Module (streaming)', () => {
    it('returns 404 if the table does not exist', async () => {
        vi.mocked(executeOperation).mockResolvedValueOnce([])

        const response = await exportTableToJsonRoute(
            'missing_table',
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(404)
        const body = (await response.json()) as { error: string }
        expect(body.error).toBe("Table 'missing_table' does not exist.")
    })

    it('streams a JSON array body', async () => {
        const rows = [
            { id: 1, name: 'Alice' },
            { id: 2, name: 'Bob' },
        ]
        mockTable(rows)

        const response = await exportTableToJsonRoute(
            'users',
            mockDataSource,
            mockConfig
        )

        expect(response.headers.get('Content-Type')).toBe('application/json')
        expect(response.headers.get('Content-Disposition')).toBe(
            'attachment; filename="users_export.json"'
        )
        expect(response.body).toBeInstanceOf(ReadableStream)

        const text = await response.text()
        // Must round-trip through JSON.parse — the streaming encoder
        // hand-assembles the array, so this is the contract that matters.
        expect(JSON.parse(text)).toEqual(rows)
    })

    it('returns "[]" for an empty table', async () => {
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'empty_table' }])
            .mockResolvedValueOnce([])

        const response = await exportTableToJsonRoute(
            'empty_table',
            mockDataSource,
            mockConfig
        )

        const text = await response.text()
        expect(text).toBe('[]')
        expect(JSON.parse(text)).toEqual([])
    })

    it('escapes special characters via JSON.stringify per row', async () => {
        const rows = [
            { id: 1, name: 'Sahithi "The Best"' },
            { id: 2, description: 'New\nLine' },
        ]
        mockTable(rows)

        const response = await exportTableToJsonRoute(
            'special_chars',
            mockDataSource,
            mockConfig
        )

        const text = await response.text()
        expect(JSON.parse(text)).toEqual(rows)
    })

    it('returns 500 when the existence check throws', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        vi.mocked(executeOperation).mockRejectedValueOnce(
            new Error('Database Error')
        )

        const response = await exportTableToJsonRoute(
            'users',
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(500)
        const body = (await response.json()) as { error: string }
        expect(body.error).toBe('Failed to export table to JSON')
    })
})
