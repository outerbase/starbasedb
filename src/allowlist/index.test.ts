import { describe, it, expect, vi, beforeEach } from 'vitest'
import { isQueryAllowed } from './index'
import type { DataSource } from '../types'
import type { StarbaseDBConfiguration } from '../handler'

vi.mock('node-sql-parser', () => {
    const Parser = vi.fn().mockImplementation(() => ({
        astify: vi.fn((sql: string) => ({ type: 'select', sql })),
    }))
    return { Parser }
})

const mockDataSource = {
    source: 'internal',
    rpc: {
        executeQuery: vi.fn(),
    },
} as unknown as DataSource

const adminConfig: StarbaseDBConfiguration = {
    outerbaseApiKey: 'key',
    role: 'admin',
    features: { allowlist: true, rls: false },
}

const clientConfig: StarbaseDBConfiguration = {
    outerbaseApiKey: 'key',
    role: 'client',
    features: { allowlist: true, rls: false },
}

beforeEach(() => {
    vi.clearAllMocks()
})

describe('isQueryAllowed', () => {
    it('should return true when allowlist feature is disabled', async () => {
        const result = await isQueryAllowed({
            sql: 'SELECT 1',
            isEnabled: false,
            dataSource: mockDataSource,
            config: clientConfig,
        })
        expect(result).toBe(true)
    })

    it('should return true for admin role regardless of allowlist', async () => {
        const result = await isQueryAllowed({
            sql: 'SELECT * FROM sensitive_table',
            isEnabled: true,
            dataSource: mockDataSource,
            config: adminConfig,
        })
        expect(result).toBe(true)
    })

    it('should return an Error when no SQL is provided', async () => {
        vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValue([
            { sql_statement: 'SELECT 1', source: 'internal' },
        ])

        const result = await isQueryAllowed({
            sql: '',
            isEnabled: true,
            dataSource: mockDataSource,
            config: clientConfig,
        })
        expect(result).toBeInstanceOf(Error)
    })

    it('should allow query matching the allowlist', async () => {
        vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValue([
            { sql_statement: 'SELECT * FROM users', source: 'internal' },
        ])

        const result = await isQueryAllowed({
            sql: 'SELECT * FROM users',
            isEnabled: true,
            dataSource: mockDataSource,
            config: clientConfig,
        })
        expect(result).toBe(true)
    })

    it('should throw when query is not in allowlist', async () => {
        vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValue([
            { sql_statement: 'SELECT * FROM users', source: 'internal' },
        ])

        await expect(
            isQueryAllowed({
                sql: 'DROP TABLE users',
                isEnabled: true,
                dataSource: mockDataSource,
                config: clientConfig,
            })
        ).rejects.toThrow()
    })

    it('should return empty allowlist when loadAllowlist query fails', async () => {
        vi.mocked(mockDataSource.rpc.executeQuery).mockRejectedValue(
            new Error('DB connection failed')
        )

        await expect(
            isQueryAllowed({
                sql: 'SELECT 1',
                isEnabled: true,
                dataSource: mockDataSource,
                config: clientConfig,
            })
        ).rejects.toThrow()
    })

    it('should filter allowlist by data source', async () => {
        vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValue([
            { sql_statement: 'SELECT 1', source: 'external' },
            { sql_statement: 'SELECT * FROM users', source: 'internal' },
        ])

        const result = await isQueryAllowed({
            sql: 'SELECT * FROM users',
            isEnabled: true,
            dataSource: mockDataSource,
            config: clientConfig,
        })
        expect(result).toBe(true)
    })
})
