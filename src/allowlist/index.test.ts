import { describe, it, expect, vi, beforeEach } from 'vitest'
import { isQueryAllowed } from './index'
import type { DataSource } from '../types'
import type { StarbaseDBConfiguration } from '../handler'

describe('Allowlist Module', () => {
    let mockDataSource: DataSource
    let mockConfig: StarbaseDBConfiguration

    beforeEach(() => {
        vi.clearAllMocks()

        mockDataSource = {
            source: 'internal',
            cache: false,
            rpc: {
                executeQuery: vi.fn(),
            },
        } as any

        mockConfig = {
            role: 'client',
            features: {
                allowlist: true,
                rls: false,
            },
        } as any
    })

    it('should return true if feature is disabled', async () => {
        const result = await isQueryAllowed({
            sql: 'SELECT * FROM users',
            isEnabled: false,
            dataSource: mockDataSource,
            config: mockConfig,
        })
        expect(result).toBe(true)
    })

    it('should return true if user is admin', async () => {
        mockConfig.role = 'admin'
        const result = await isQueryAllowed({
            sql: 'SELECT * FROM users',
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })
        expect(result).toBe(true)
    })

    it('should return error if no SQL is provided', async () => {
        const result = await isQueryAllowed({
            sql: '',
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })
        expect(result).toBeInstanceOf(Error)
        expect((result as Error).message).toBe(
            'No SQL provided for allowlist check'
        )
    })

    it('should return true if query is in allowlist', async () => {
        vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValue([
            { sql_statement: 'SELECT * FROM users', source: 'internal' },
        ])

        const result = await isQueryAllowed({
            sql: 'SELECT * FROM users',
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })
        expect(result).toBe(true)
    })

    it('should throw if query is not in allowlist', async () => {
        vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValue([
            { sql_statement: 'SELECT * FROM users', source: 'internal' },
        ])

        await expect(
            isQueryAllowed({
                sql: 'SELECT * FROM admins',
                isEnabled: true,
                dataSource: mockDataSource,
                config: mockConfig,
            })
        ).rejects.toThrow('Query not allowed')
    })

    it('should allow queries with different whitespace/semicolons but same AST', async () => {
        vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValue([
            { sql_statement: 'SELECT * FROM users', source: 'internal' },
        ])

        const result = await isQueryAllowed({
            sql: 'SELECT * \nFROM \t users;   ',
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })
        expect(result).toBe(true)
    })
})
