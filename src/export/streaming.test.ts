import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { executeOperation } from '.'
import type { DataSource } from '../types'
import type { StarbaseDBConfiguration } from '../handler'
import {
    createStreamingExportResponse,
    formatCsvValue,
    formatSqlValue,
    getTableColumns,
    iterateTableRows,
    quoteSqlIdentifier,
    tableExists,
} from './streaming'

vi.mock('.', () => ({
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

afterEach(() => {
    vi.unstubAllGlobals()
})

describe('Export Streaming Helpers', () => {
    it('should quote SQL identifiers safely', () => {
        expect(quoteSqlIdentifier('users')).toBe('"users"')
        expect(quoteSqlIdentifier('weird"name')).toBe('"weird""name"')
    })

    it('should format SQL values without producing invalid undefined literals', () => {
        expect(formatSqlValue(null)).toBe('NULL')
        expect(formatSqlValue(undefined)).toBe('NULL')
        expect(formatSqlValue("Alice's")).toBe("'Alice''s'")
        expect(formatSqlValue(true)).toBe('1')
        expect(formatSqlValue(new Uint8Array([0, 15, 255]))).toBe("X'000fff'")
    })

    it('should escape CSV values only when needed', () => {
        expect(formatCsvValue('Alice')).toBe('Alice')
        expect(formatCsvValue('Alice, Bob')).toBe('"Alice, Bob"')
        expect(formatCsvValue('Alice "A"')).toBe('"Alice ""A"""')
        expect(formatCsvValue(null)).toBe('')
    })

    it('should check table existence with a bound table name', async () => {
        vi.mocked(executeOperation).mockResolvedValueOnce([{ name: 'users' }])

        await expect(
            tableExists('users', mockDataSource, mockConfig)
        ).resolves.toBe(true)

        expect(executeOperation).toHaveBeenCalledWith(
            [
                {
                    sql: "SELECT name FROM sqlite_master WHERE type='table' AND name=?;",
                    params: ['users'],
                },
            ],
            mockDataSource,
            mockConfig
        )
    })

    it('should read column names from table metadata', async () => {
        vi.mocked(executeOperation).mockResolvedValueOnce([
            { name: 'id' },
            { name: 'name' },
        ])

        await expect(
            getTableColumns('users', mockDataSource, mockConfig)
        ).resolves.toEqual(['id', 'name'])
    })

    it('should iterate table rows in bounded pages and yield between full pages', async () => {
        const wait = vi.fn().mockResolvedValue(undefined)
        vi.stubGlobal('scheduler', { wait })

        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ id: 1 }, { id: 2 }])
            .mockResolvedValueOnce([{ id: 3 }])

        const rows = []

        for await (const row of iterateTableRows(
            'users',
            mockDataSource,
            mockConfig,
            2
        )) {
            rows.push(row)
        }

        expect(rows).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }])
        expect(wait).toHaveBeenCalledWith(0)
        expect(executeOperation).toHaveBeenNthCalledWith(
            1,
            [
                {
                    sql: 'SELECT * FROM "users" LIMIT ? OFFSET ?;',
                    params: [2, 0],
                },
            ],
            mockDataSource,
            mockConfig
        )
        expect(executeOperation).toHaveBeenNthCalledWith(
            2,
            [
                {
                    sql: 'SELECT * FROM "users" LIMIT ? OFFSET ?;',
                    params: [2, 2],
                },
            ],
            mockDataSource,
            mockConfig
        )
    })

    it('should create a readable streaming response', async () => {
        async function* chunks() {
            yield 'hello'
            yield ' '
            yield 'world'
        }

        const response = createStreamingExportResponse(
            chunks(),
            'hello.txt',
            'text/plain'
        )

        expect(response.headers.get('Content-Type')).toBe('text/plain')
        expect(response.headers.get('Cache-Control')).toBe('no-store')
        await expect(response.text()).resolves.toBe('hello world')
    })
})
