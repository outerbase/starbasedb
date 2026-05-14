import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
    createExportResponse,
    createExportStreamResponse,
    createTextStream,
    executeOperation,
    getTableData,
    getTableDataBatches,
    quoteSqlIdentifier,
    tableExists,
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

    describe('tableExists', () => {
        it('should return true if the table exists', async () => {
            vi.mocked(executeTransaction).mockResolvedValueOnce([
                { name: 'users' },
            ])

            await expect(
                tableExists('users', mockDataSource, mockConfig)
            ).resolves.toBe(true)
        })

        it('should return false if the table does not exist', async () => {
            vi.mocked(executeTransaction).mockResolvedValueOnce([])

            await expect(
                tableExists('missing_table', mockDataSource, mockConfig)
            ).resolves.toBe(false)
        })
    })

    describe('getTableDataBatches', () => {
        it('should fetch rows in batches until no rows remain', async () => {
            vi.mocked(executeTransaction)
                .mockResolvedValueOnce([{ id: 1 }])
                .mockResolvedValueOnce([{ id: 2 }])
                .mockResolvedValueOnce([])

            const rows: any[] = []

            for await (const batch of getTableDataBatches(
                'users',
                mockDataSource,
                mockConfig,
                1
            )) {
                rows.push(...batch)
            }

            expect(rows).toEqual([{ id: 1 }, { id: 2 }])
            expect(executeTransaction).toHaveBeenNthCalledWith(
                1,
                expect.objectContaining({
                    queries: [
                        {
                            sql: 'SELECT * FROM "users" LIMIT ? OFFSET ?;',
                            params: [1, 0],
                        },
                    ],
                })
            )
            expect(executeTransaction).toHaveBeenNthCalledWith(
                2,
                expect.objectContaining({
                    queries: [
                        {
                            sql: 'SELECT * FROM "users" LIMIT ? OFFSET ?;',
                            params: [1, 1],
                        },
                    ],
                })
            )
            expect(executeTransaction).toHaveBeenNthCalledWith(
                3,
                expect.objectContaining({
                    queries: [
                        {
                            sql: 'SELECT * FROM "users" LIMIT ? OFFSET ?;',
                            params: [1, 2],
                        },
                    ],
                })
            )
        })

        it('should quote table identifiers used in batch queries', async () => {
            vi.mocked(executeTransaction).mockResolvedValueOnce([])

            const rows: any[] = []

            for await (const batch of getTableDataBatches(
                'user"events',
                mockDataSource,
                mockConfig,
                10
            )) {
                rows.push(...batch)
            }

            expect(rows).toEqual([])
            expect(executeTransaction).toHaveBeenCalledWith(
                expect.objectContaining({
                    queries: [
                        {
                            sql: 'SELECT * FROM "user""events" LIMIT ? OFFSET ?;',
                            params: [10, 0],
                        },
                    ],
                })
            )
        })
    })

    describe('quoteSqlIdentifier', () => {
        it('should quote double quotes inside identifiers', () => {
            expect(quoteSqlIdentifier('user"events')).toBe('"user""events"')
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

    describe('streaming export responses', () => {
        it('should create a readable text stream response', async () => {
            const stream = createTextStream(async (enqueue) => {
                enqueue('hello')
                enqueue(' world')
            })
            const response = createExportStreamResponse(
                stream,
                'notes.txt',
                'text/plain'
            )

            expect(response.headers.get('Content-Type')).toBe('text/plain')
            expect(response.headers.get('Content-Disposition')).toBe(
                'attachment; filename="notes.txt"'
            )
            await expect(response.text()).resolves.toBe('hello world')
        })
    })
})
