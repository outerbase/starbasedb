import { describe, it, expect, vi, beforeEach } from 'vitest'
import { isQueryAllowed } from './index'
import type { DataSource } from '../types'
import type { StarbaseDBConfiguration } from '../handler'

let mockDataSource: DataSource
let mockConfig: StarbaseDBConfiguration

beforeEach(() => {
    vi.clearAllMocks()

    mockDataSource = {
        source: 'main-db',
        rpc: {
            executeQuery: vi.fn(),
        },
    } as any

    mockConfig = {
        role: 'user',
    } as any
})

describe('Allowlist Module', () => {
    it('should allow all queries when allowlist is disabled', async () => {
        const result = await isQueryAllowed({
            sql: 'SELECT * FROM users;',
            isEnabled: false,
            dataSource: mockDataSource,
            config: mockConfig,
        })
        expect(result).toBe(true)
        expect(mockDataSource.rpc.executeQuery).not.toHaveBeenCalled()
    })

    it('should allow any query when user role is admin', async () => {
        const adminConfig: StarbaseDBConfiguration = { role: 'admin' } as any
        const result = await isQueryAllowed({
            sql: 'DROP TABLE users;',
            isEnabled: true,
            dataSource: mockDataSource,
            config: adminConfig,
        })
        expect(result).toBe(true)
        expect(mockDataSource.rpc.executeQuery).not.toHaveBeenCalled()
    })

    it('should throw an error when no SQL string is provided', async () => {
        ;(mockDataSource.rpc.executeQuery as any).mockResolvedValueOnce([])
        await expect(
            isQueryAllowed({
                sql: '',
                isEnabled: true,
                dataSource: mockDataSource,
                config: mockConfig,
            })
        ).rejects.toThrow('No SQL provided for allowlist check')
    })

    it('should allow query matching an exact allowed statement', async () => {
        ;(mockDataSource.rpc.executeQuery as any).mockResolvedValueOnce([
            { sql_statement: 'SELECT id, name FROM users', source: 'main-db' },
        ])

        const result = await isQueryAllowed({
            sql: 'SELECT id, name FROM users;',
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })
        expect(result).toBe(true)
    })

    it('should normalize trailing semicolons and whitespace', async () => {
        ;(mockDataSource.rpc.executeQuery as any).mockResolvedValueOnce([
            { sql_statement: 'SELECT * FROM products;', source: 'main-db' },
        ])

        const result = await isQueryAllowed({
            sql: 'SELECT * FROM products',
            isEnabled: true,
            dataSource: mockDataSource,
            config: mockConfig,
        })
        expect(result).toBe(true)
    })

    it('should reject unlisted query and record it in tmp_allowlist_rejections', async () => {
        ;(mockDataSource.rpc.executeQuery as any)
            .mockResolvedValueOnce([
                { sql_statement: 'SELECT id FROM users', source: 'main-db' },
            ])
            .mockResolvedValueOnce([])

        await expect(
            isQueryAllowed({
                sql: 'DELETE FROM users WHERE id = 1;',
                isEnabled: true,
                dataSource: mockDataSource,
                config: mockConfig,
            })
        ).rejects.toThrow('Query not allowed')

        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: 'INSERT INTO tmp_allowlist_rejections (sql_statement, source) VALUES (?, ?)',
            params: ['DELETE FROM users WHERE id = 1;', 'main-db'],
        })
    })

    it('should handle data source query execution errors gracefully by falling back to empty allowlist', async () => {
        ;(mockDataSource.rpc.executeQuery as any).mockRejectedValueOnce(
            new Error('Database offline')
        )

        await expect(
            isQueryAllowed({
                sql: 'SELECT 1;',
                isEnabled: true,
                dataSource: mockDataSource,
                config: mockConfig,
            })
        ).rejects.toThrow('Query not allowed')
    })
})
