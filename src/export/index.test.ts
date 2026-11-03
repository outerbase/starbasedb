import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
    executeOperation,
    getTableData,
    createExportResponse,
    quoteIdentifier,
    EXPORT_BATCH_SIZE,
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
    describe('quoteIdentifier', () => {
        it('should leave simple alphanumeric identifiers unquoted', () => {
            expect(quoteIdentifier('users')).toBe('users')
            expect(quoteIdentifier('tmp_cache_1')).toBe('tmp_cache_1')
        })

        it('should quote identifiers containing periods, spaces, or quotes', () => {
            expect(quoteIdentifier('users.table')).toBe('"users.table"')
            expect(quoteIdentifier('my "special" table')).toBe(
                '"my ""special"" table"'
            )
        })
    })

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

        it('should paginate across multiple batches when table exceeds batchSize', async () => {
            vi.mocked(executeTransaction)
                .mockResolvedValueOnce([{ name: 'users' }])
                .mockResolvedValueOnce([
                    { id: 1, name: 'Alice' },
                    { id: 2, name: 'Bob' },
                ])
                .mockResolvedValueOnce([
                    { id: 3, name: 'Charlie' },
                    { id: 4, name: 'Diana' },
                ])
                .mockResolvedValueOnce([{ id: 5, name: 'Eve' }])

            const result = await getTableData(
                'users',
                mockDataSource,
                mockConfig,
                2
            )

            expect(result).toEqual([
                { id: 1, name: 'Alice' },
                { id: 2, name: 'Bob' },
                { id: 3, name: 'Charlie' },
                { id: 4, name: 'Diana' },
                { id: 5, name: 'Eve' },
            ])
            expect(executeTransaction).toHaveBeenCalledTimes(4)
            expect(executeTransaction).toHaveBeenNthCalledWith(2, {
                queries: [{ sql: 'SELECT * FROM users LIMIT 2 OFFSET 0;' }],
                isRaw: false,
                dataSource: mockDataSource,
                config: mockConfig,
            })
            expect(executeTransaction).toHaveBeenNthCalledWith(3, {
                queries: [{ sql: 'SELECT * FROM users LIMIT 2 OFFSET 2;' }],
                isRaw: false,
                dataSource: mockDataSource,
                config: mockConfig,
            })
            expect(executeTransaction).toHaveBeenNthCalledWith(4, {
                queries: [{ sql: 'SELECT * FROM users LIMIT 2 OFFSET 4;' }],
                isRaw: false,
                dataSource: mockDataSource,
                config: mockConfig,
            })
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
            consoleErrorMock.mockRestore()
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

        it('should stream a ReadableStream directly without buffering into a Blob', async () => {
            const encoder = new TextEncoder()
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(encoder.encode('chunk1-'))
                    controller.enqueue(encoder.encode('chunk2'))
                    controller.close()
                },
            })

            const response = createExportResponse(
                stream,
                'streamed.csv',
                'text/csv'
            )

            expect(response.headers.get('Content-Type')).toBe('text/csv')
            expect(response.headers.get('Content-Disposition')).toBe(
                'attachment; filename="streamed.csv"'
            )
            expect(await response.text()).toBe('chunk1-chunk2')
            expect(EXPORT_BATCH_SIZE).toBe(1000)
        })
    })
})
