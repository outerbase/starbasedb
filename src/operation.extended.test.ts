import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
    executeQuery,
    executeTransaction,
    executeExternalQuery,
} from './operation'
import type { DataSource } from './types'
import type { StarbaseDBConfiguration } from './handler'

describe('operation.ts - Extended Coverage', () => {
    let mockDataSource: DataSource
    let mockConfig: StarbaseDBConfiguration

    beforeEach(() => {
        vi.clearAllMocks()

        mockConfig = {
            role: 'client',
            outerbaseApiKey: 'token-outerbase-123',
            features: { allowlist: false, rls: false, rest: true },
        }

        mockDataSource = {
            source: 'internal',
            rpc: {
                executeQuery: vi.fn().mockResolvedValue([
                    { id: 10, name: 'Alice' },
                    { id: 20, name: 'Bob' },
                ]),
                executeTransaction: vi.fn(),
            } as any,
        }
    })

    describe('executeExternalQuery', () => {
        it('should throw an error if dataSource.external is missing', async () => {
            const dsNoExternal: DataSource = {
                source: 'external',
                rpc: {} as any,
            }

            await expect(
                executeExternalQuery({
                    sql: 'SELECT 1',
                    params: [],
                    dataSource: dsNoExternal,
                    config: mockConfig,
                })
            ).rejects.toThrow('External connection not found.')
        })

        it('should call Outerbase raw API and convert ? params to :paramX format', async () => {
            const dsExternal: DataSource = {
                source: 'external',
                external: {
                    dialect: 'postgresql',
                    provider: 'postgresql',
                    host: 'localhost',
                    port: 5432,
                    user: 'user',
                    password: 'pw',
                    database: 'db',
                } as any,
                rpc: {} as any,
            }

            const mockFetch = vi.fn().mockResolvedValue({
                ok: true,
                json: vi.fn().mockResolvedValue({
                    response: {
                        results: {
                            items: [{ id: 1, name: 'Outerbase-Item' }],
                        },
                    },
                }),
            })
            global.fetch = mockFetch

            const result = await executeExternalQuery({
                sql: 'SELECT * FROM users WHERE id = ? AND status = ?',
                params: [123, 'active'],
                dataSource: dsExternal,
                config: mockConfig,
            })

            expect(mockFetch).toHaveBeenCalledWith(
                'https://app.outerbase.com/api/v1/ezql/raw',
                expect.objectContaining({
                    method: 'POST',
                    headers: expect.objectContaining({
                        'X-Source-Token': 'token-outerbase-123',
                    }),
                    body: JSON.stringify({
                        query: 'SELECT * FROM users WHERE id = :param0 AND status = :param1',
                        params: { param0: 123, param1: 'active' },
                    }),
                })
            )

            expect(result).toEqual([{ id: 1, name: 'Outerbase-Item' }])
        })

        it('should return empty array when Outerbase raw API response is malformed', async () => {
            vi.spyOn(console, 'error').mockImplementation(() => {})

            const dsExternal: DataSource = {
                source: 'external',
                external: { provider: 'postgres' } as any,
                rpc: {} as any,
            }

            global.fetch = vi.fn().mockResolvedValue({
                ok: false,
                json: vi.fn().mockResolvedValue({
                    message: 'API Token revoked',
                }),
            })

            const result = await executeExternalQuery({
                sql: 'SELECT 1',
                params: [],
                dataSource: dsExternal,
                config: mockConfig,
            })

            expect(result).toEqual([])
        })
    })

    describe('Plugin registry beforeQuery & afterQuery lifecycle', () => {
        it('should pass through beforeQuery and afterQuery with registry modifications', async () => {
            const registry = {
                beforeQuery: vi.fn().mockResolvedValue({
                    sql: 'SELECT * FROM users WHERE active = 1',
                    params: [999],
                }),
                afterQuery: vi.fn().mockImplementation(async ({ result }) => {
                    return result.map((r: any) => ({ ...r, decorated: true }))
                }),
            }

            const dsWithRegistry: DataSource = {
                source: 'internal',
                registry: registry as any,
                rpc: {
                    executeQuery: vi
                        .fn()
                        .mockResolvedValue([{ id: 1, name: 'Test' }]),
                } as any,
            }

            const result = await executeQuery({
                sql: 'SELECT * FROM users',
                params: [],
                isRaw: false,
                dataSource: dsWithRegistry,
                config: mockConfig,
            })

            expect(registry.beforeQuery).toHaveBeenCalled()
            expect(dsWithRegistry.rpc.executeQuery).toHaveBeenCalledWith(
                expect.objectContaining({
                    sql: 'SELECT * FROM users WHERE active = 1',
                    params: [999],
                })
            )
            expect(registry.afterQuery).toHaveBeenCalled()
            expect(result).toEqual([{ id: 1, name: 'Test', decorated: true }])
        })

        it('should gracefully catch and ignore errors inside afterQuery registry plugin', async () => {
            vi.spyOn(console, 'error').mockImplementation(() => {})

            const registry = {
                beforeQuery: vi
                    .fn()
                    .mockImplementation(async ({ sql, params }) => ({
                        sql,
                        params,
                    })),
                afterQuery: vi
                    .fn()
                    .mockRejectedValue(new Error('Plugin hook failed')),
            }

            const dsWithFailingRegistry: DataSource = {
                source: 'internal',
                registry: registry as any,
                rpc: {
                    executeQuery: vi.fn().mockResolvedValue([{ id: 1 }]),
                } as any,
            }

            const result = await executeQuery({
                sql: 'SELECT 1',
                params: [],
                isRaw: false,
                dataSource: dsWithFailingRegistry,
                config: mockConfig,
            })

            expect(result).toEqual([{ id: 1 }])
        })
    })

    describe('executeTransaction', () => {
        it('should return empty array if dataSource is not provided', async () => {
            vi.spyOn(console, 'error').mockImplementation(() => {})

            const result = await executeTransaction({
                queries: [{ sql: 'SELECT 1' }],
                isRaw: false,
                dataSource: undefined as any,
                config: mockConfig,
            })

            expect(result).toEqual([])
        })

        it('should execute each transaction query sequentially on data source via executeQuery', async () => {
            const queries = [
                { sql: 'INSERT INTO users VALUES (1, "A")' },
                { sql: 'INSERT INTO users VALUES (2, "B")' },
            ]

            const result = await executeTransaction({
                queries,
                isRaw: false,
                dataSource: mockDataSource,
                config: mockConfig,
            })

            expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledTimes(2)
            expect(result).toHaveLength(2)
        })
    })
})
