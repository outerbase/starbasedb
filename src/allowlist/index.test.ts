import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isQueryAllowed } from './index'
import type { DataSource } from '../types'

let mockDataSource: DataSource

beforeEach(() => {
    vi.clearAllMocks()
    mockDataSource = {
        source: 'external',
        rpc: {
            executeQuery: vi.fn(),
        },
    } as any
})

describe('allowlist', () => {
    it('allows queries when the feature is disabled', async () => {
        const allowed = await isQueryAllowed({
            sql: 'DELETE FROM users',
            isEnabled: false,
            dataSource: mockDataSource,
            config: { role: 'user' } as any,
        })

        expect(allowed).toBe(true)
        expect(mockDataSource.rpc.executeQuery).not.toHaveBeenCalled()
    })

    it('allows admin role queries without loading the allowlist', async () => {
        const allowed = await isQueryAllowed({
            sql: 'DELETE FROM users',
            isEnabled: true,
            dataSource: mockDataSource,
            config: { role: 'admin' } as any,
        })

        expect(allowed).toBe(true)
        expect(mockDataSource.rpc.executeQuery).not.toHaveBeenCalled()
    })

    it('allows a query whose normalized AST matches an allowlisted query', async () => {
        vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValue([
            {
                sql_statement: 'SELECT id, name FROM users WHERE status = "active"',
                source: 'external',
            },
        ])

        const allowed = await isQueryAllowed({
            sql: 'SELECT id, name FROM users WHERE status = "active";',
            isEnabled: true,
            dataSource: mockDataSource,
            config: { role: 'user' } as any,
        })

        expect(allowed).toBe(true)
        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: 'SELECT sql_statement, source FROM tmp_allowlist_queries WHERE source="external"',
        })
    })

    it('rejects and records a query that is not on the allowlist', async () => {
        vi.mocked(mockDataSource.rpc.executeQuery)
            .mockResolvedValueOnce([
                {
                    sql_statement: 'SELECT id FROM users',
                    source: 'external',
                },
            ])
            .mockResolvedValueOnce([])

        await expect(
            isQueryAllowed({
                sql: 'SELECT email FROM users',
                isEnabled: true,
                dataSource: mockDataSource,
                config: { role: 'user' } as any,
            })
        ).rejects.toThrow('Query not allowed')

        expect(mockDataSource.rpc.executeQuery).toHaveBeenLastCalledWith({
            sql: 'INSERT INTO tmp_allowlist_rejections (sql_statement, source) VALUES (?, ?)',
            params: ['SELECT email FROM users', 'external'],
        })
    })

    it('throws a clear error when SQL is empty', async () => {
        vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValue([])

        await expect(
            isQueryAllowed({
                sql: '',
                isEnabled: true,
                dataSource: mockDataSource,
                config: { role: 'user' } as any,
            })
        ).rejects.toThrow('No SQL provided for allowlist check')
    })
})
