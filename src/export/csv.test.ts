import { describe, it, expect, vi, beforeEach } from 'vitest'
import { exportTableToCsvRoute } from './csv'
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

/** Wire up an existence check followed by a single page of rows. */
function mockTable(rows: any[]) {
    vi.mocked(executeOperation)
        .mockResolvedValueOnce([{ name: 'tbl' }]) // existence check
        .mockResolvedValueOnce(rows) // first page
        .mockResolvedValueOnce([]) // empty page → terminate
}

describe('CSV Export Module (streaming)', () => {
    it('streams a CSV body when the table has data', async () => {
        mockTable([
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
        expect(response.body).toBeInstanceOf(ReadableStream)

        const csv = await response.text()
        expect(csv).toBe('id,name,age\n1,Alice,30\n2,Bob,25\n')
    })

    it('returns 404 if the table does not exist', async () => {
        vi.mocked(executeOperation).mockResolvedValueOnce([])

        const response = await exportTableToCsvRoute(
            'non_existent_table',
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(404)
        const body = (await response.json()) as { error: string }
        expect(body.error).toBe("Table 'non_existent_table' does not exist.")
    })

    it('emits an empty body for an empty table (header row needs at least one row to know columns)', async () => {
        mockTable([])
        // mockTable above queues two empty pages after the existence check; we
        // only need one. Re-prime to keep this scenario explicit.
        vi.mocked(executeOperation).mockReset()
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ name: 'empty_table' }])
            .mockResolvedValueOnce([])

        const response = await exportTableToCsvRoute(
            'empty_table',
            mockDataSource,
            mockConfig
        )

        expect(response.headers.get('Content-Type')).toBe('text/csv')
        const csv = await response.text()
        expect(csv).toBe('')
    })

    it('quotes fields containing commas, quotes, or newlines', async () => {
        mockTable([{ id: 1, name: 'Sahithi, is', bio: 'my forever "penguin"' }])

        const response = await exportTableToCsvRoute(
            'special_chars',
            mockDataSource,
            mockConfig
        )

        const csv = await response.text()
        expect(csv).toBe(
            'id,name,bio\n1,"Sahithi, is","my forever ""penguin"""\n'
        )
    })

    it('returns 500 when the existence check throws', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        vi.mocked(executeOperation).mockRejectedValueOnce(
            new Error('Database Error')
        )

        const response = await exportTableToCsvRoute(
            'users',
            mockDataSource,
            mockConfig
        )

        expect(response.status).toBe(500)
        const body = (await response.json()) as { error: string }
        expect(body.error).toBe('Failed to export table to CSV')
    })

    it('reads pages with parameterised LIMIT/OFFSET', async () => {
        mockTable([{ id: 1, name: 'Alice' }])

        const response = await exportTableToCsvRoute(
            'users',
            mockDataSource,
            mockConfig
        )
        await response.text()

        const dataCall = vi
            .mocked(executeOperation)
            .mock.calls.find(([qs]) =>
                qs[0].sql.startsWith('SELECT * FROM users')
            )
        expect(dataCall).toBeDefined()
        expect(dataCall![0][0].sql).toContain('LIMIT ? OFFSET ?')
    })
})
