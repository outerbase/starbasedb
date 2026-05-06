import { describe, it, expect, vi, beforeEach } from 'vitest'
import { executeOperation } from './index'
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
})
