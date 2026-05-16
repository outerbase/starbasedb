import { describe, expect, it, vi, beforeEach } from 'vitest'
import { executeOperation } from './index'
import {
    createStreamingExportResponse,
    formatCsvValue,
    formatSqlValue,
    iterateTableRows,
    quoteSqlIdentifier,
    type TablePagePlan,
} from './streaming'
import type { DataSource } from '../types'
import type { StarbaseDBConfiguration } from '../handler'

vi.mock('./index', () => ({
    executeOperation: vi.fn(),
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

describe('Streaming export helpers', () => {
    it('quotes SQL identifiers and formats SQL values safely', () => {
        expect(quoteSqlIdentifier('weird"name')).toBe('"weird""name"')
        expect(formatSqlValue(null)).toBe('NULL')
        expect(formatSqlValue(Number.NaN)).toBe('NULL')
        expect(formatSqlValue(true)).toBe('1')
        expect(formatSqlValue("Alice's adventure")).toBe("'Alice''s adventure'")
        expect(formatSqlValue(new Uint8Array([0, 15, 255]))).toBe("X'000fff'")
    })

    it('formats CSV values without buffering a full export', () => {
        expect(formatCsvValue(null)).toBe('')
        expect(formatCsvValue('plain')).toBe('plain')
        expect(formatCsvValue('a,b')).toBe('"a,b"')
        expect(formatCsvValue('say "hi"')).toBe('"say ""hi"""')
    })

    it('streams iterable chunks with sanitized attachment names', async () => {
        async function* chunks() {
            yield 'a'
            yield 'b'
        }

        const response = createStreamingExportResponse(
            chunks(),
            '../bad:name.csv',
            'text/csv'
        )

        expect(response.headers.get('Content-Disposition')).toBe(
            'attachment; filename=".._bad_name.csv"'
        )
        await expect(response.text()).resolves.toBe('ab')
    })

    it('uses keyset pagination after a full page', async () => {
        const pagePlan: TablePagePlan = {
            columns: ['id', 'name'],
            selectList: '*',
            orderBy: ['"id"'],
            cursorColumns: [{ expression: '"id"', resultKey: 'id' }],
        }

        vi.mocked(executeOperation)
            .mockResolvedValueOnce([
                { id: 1, name: 'Alice' },
                { id: 2, name: 'Bob' },
            ])
            .mockResolvedValueOnce([{ id: 3, name: 'Cleo' }])

        const rows = []
        for await (const row of iterateTableRows(
            'users',
            mockDataSource,
            mockConfig,
            { pagePlan, pageSize: 2 }
        )) {
            rows.push(row)
        }

        expect(rows).toEqual([
            { id: 1, name: 'Alice' },
            { id: 2, name: 'Bob' },
            { id: 3, name: 'Cleo' },
        ])

        expect(vi.mocked(executeOperation).mock.calls[0][0][0]).toMatchObject({
            sql: 'SELECT * FROM "users" ORDER BY "id" ASC LIMIT ?;',
            params: [2],
        })
        expect(vi.mocked(executeOperation).mock.calls[1][0][0]).toMatchObject({
            sql: 'SELECT * FROM "users" WHERE ("id" > ?) ORDER BY "id" ASC LIMIT ?;',
            params: [2, 2],
        })
    })

    it('keeps internal rowid cursors out of exported rows', async () => {
        const pagePlan: TablePagePlan = {
            columns: ['name'],
            selectList: '*, rowid AS "__starbasedb_export_rowid"',
            orderBy: ['rowid'],
            cursorColumns: [
                {
                    expression: 'rowid',
                    resultKey: '__starbasedb_export_rowid',
                },
            ],
            rowidAlias: '__starbasedb_export_rowid',
        }

        vi.mocked(executeOperation).mockResolvedValueOnce([
            { name: 'Alice', __starbasedb_export_rowid: 1 },
        ])

        const rows = []
        for await (const row of iterateTableRows(
            'users',
            mockDataSource,
            mockConfig,
            { pagePlan, pageSize: 2 }
        )) {
            rows.push(row)
        }

        expect(rows).toEqual([{ name: 'Alice' }])
    })
})
