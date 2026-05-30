import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
    executeOperation,
    getTableData,
    getTableDataChunked,
    createExportResponse,
    createStreamingExportResponse,
} from './index'
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

describe('Database Operations Module', () => {
    describe('executeOperation', () => {
        it('should return the first result when transaction succeeds', async () => {
            vi.mocked(executeTransaction).mockResolvedValue([
                [{ id: 1, name: 'Alice' }],
            ])

            const result = await executeOperation(
                [{ sql: 'SELECT * FROM users' }],
                mockDataSource,
                mockConfig
            )

            expect(executeTransaction).toHaveBeenCalledWith({
                queries: [{ sql: 'SELECT * FROM users' }],
                isRaw: false,
                dataSource: mockDataSource,
                config: mockConfig,
            })
            expect(result).toEqual([{ id: 1, name: 'Alice' }])
        })

        it('should return empty array if transaction returns an empty array', async () => {
            vi.mocked(executeTransaction).mockResolvedValue([])

            const result = await executeOperation(
                [{ sql: 'SELECT * FROM users' }],
                mockDataSource,
                mockConfig
            )

            expect(result).toEqual([])
        })
    })

    describe('getTableData', () => {
        it('should return table data if the table exists', async () => {
            vi.mocked(executeTransaction)
                .mockResolvedValueOnce([{ name: 'users' }])
                .mockResolvedValueOnce([
                    { id: 1, name: 'Alice' },
                    { id: 2, name: 'Bob' },
                ])

            const result = await getTableData(
                'users',
                mockDataSource,
                mockConfig
            )

            expect(result).toEqual([
                { id: 1, name: 'Alice' },
                { id: 2, name: 'Bob' },
            ])
        })

        it('should return null if table does not exist', async () => {
            vi.mocked(executeTransaction).mockResolvedValueOnce([])

            const result = await getTableData(
                'missing_table',
                mockDataSource,
                mockConfig
            )

            expect(result).toBeNull()
        })

        it('should throw an error when there is a database issue', async () => {
            const consoleErrorMock = vi
                .spyOn(console, 'error')
                .mockImplementation(() => {})
            vi.mocked(executeTransaction).mockRejectedValue(
                new Error('Database Error')
            )

            await expect(
                getTableData('users', mockDataSource, mockConfig)
            ).rejects.toThrow('Database Error')
        })
    })

    describe('getTableDataChunked', () => {
        it('should yield rows in chunks using LIMIT/OFFSET', async () => {
            // First page: full chunk
            vi.mocked(executeTransaction)
                .mockResolvedValueOnce([
                    Array.from({ length: 1000 }, (_, i) => ({ id: i + 1 })),
                ])
                // Second page: partial chunk — signals end of data
                .mockResolvedValueOnce([
                    Array.from({ length: 42 }, (_, i) => ({ id: 1001 + i })),
                ])

            const allRows: any[] = []
            for await (const chunk of getTableDataChunked(
                'big_table',
                mockDataSource,
                mockConfig,
                1000
            )) {
                allRows.push(...chunk)
            }

            expect(allRows).toHaveLength(1042)
            expect(executeTransaction).toHaveBeenCalledTimes(2)
        })

        it('should stop when the first chunk is empty', async () => {
            vi.mocked(executeTransaction).mockResolvedValueOnce([[]])

            const allRows: any[] = []
            for await (const chunk of getTableDataChunked(
                'empty_table',
                mockDataSource,
                mockConfig
            )) {
                allRows.push(...chunk)
            }

            expect(allRows).toHaveLength(0)
        })

        it('should handle exactly one full chunk with no more pages', async () => {
            vi.mocked(executeTransaction)
                .mockResolvedValueOnce([
                    Array.from({ length: 1000 }, (_, i) => ({ id: i + 1 })),
                ])
                .mockResolvedValueOnce([[]])

            const chunks: any[][] = []
            for await (const chunk of getTableDataChunked(
                'table',
                mockDataSource,
                mockConfig,
                1000
            )) {
                chunks.push(chunk)
            }

            expect(chunks).toHaveLength(1)
            expect(chunks[0]).toHaveLength(1000)
        })
    })

    describe('createExportResponse', () => {
        it('should create a valid response for a CSV file', () => {
            const response = createExportResponse(
                'id,name\n1,Alice\n2,Bob',
                'users.csv',
                'text/csv'
            )

            expect(response.headers.get('Content-Type')).toBe('text/csv')
            expect(response.headers.get('Content-Disposition')).toBe(
                'attachment; filename="users.csv"'
            )
        })

        it('should create a valid response for a JSON file', () => {
            const jsonData = JSON.stringify([
                { id: 1, name: 'Alice' },
                { id: 2, name: 'Bob' },
            ])
            const response = createExportResponse(
                jsonData,
                'users.json',
                'application/json'
            )

            expect(response.headers.get('Content-Type')).toBe(
                'application/json'
            )
            expect(response.headers.get('Content-Disposition')).toBe(
                'attachment; filename="users.json"'
            )
        })

        it('should create a valid response for a text file', () => {
            const response = createExportResponse(
                'Simple Text',
                'notes.txt',
                'text/plain'
            )

            expect(response.headers.get('Content-Type')).toBe('text/plain')
            expect(response.headers.get('Content-Disposition')).toBe(
                'attachment; filename="notes.txt"'
            )
        })
    })

    describe('createStreamingExportResponse', () => {
        it('should return a Response with correct Content-Type and Content-Disposition', () => {
            async function* gen(): AsyncGenerator<string> {
                yield 'hello'
            }

            const response = createStreamingExportResponse(
                'output.csv',
                'text/csv',
                gen()
            )

            expect(response.headers.get('Content-Type')).toBe('text/csv')
            expect(response.headers.get('Content-Disposition')).toBe(
                'attachment; filename="output.csv"'
            )
        })

        it('should stream all generator chunks into the response body', async () => {
            async function* gen(): AsyncGenerator<string> {
                yield 'id,name\n'
                yield '1,Alice\n'
                yield '2,Bob\n'
            }

            const response = createStreamingExportResponse(
                'users.csv',
                'text/csv',
                gen()
            )

            const text = await response.text()
            expect(text).toBe('id,name\n1,Alice\n2,Bob\n')
        })
    })
})
