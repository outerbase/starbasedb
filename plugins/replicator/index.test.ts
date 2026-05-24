import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/operation', () => ({
    executeSDKQuery: vi.fn(),
}))

import { ReplicatorPlugin } from './index'
import { executeSDKQuery } from '../../src/operation'
import { DataSource, ExternalDatabaseSource } from '../../src/types'

const mockExecuteSDKQuery = executeSDKQuery as unknown as ReturnType<
    typeof vi.fn
>

const externalSource: ExternalDatabaseSource = {
    dialect: 'postgresql',
    host: 'localhost',
    port: 5432,
    user: 'user',
    password: 'pass',
    database: 'db',
}

let dataSource: DataSource
let executeQuery: ReturnType<typeof vi.fn>

function buildDataSource() {
    executeQuery = vi.fn().mockResolvedValue([])
    return {
        rpc: { executeQuery },
        source: 'internal',
    } as unknown as DataSource
}

beforeEach(() => {
    vi.clearAllMocks()
    dataSource = buildDataSource()
})

describe('ReplicatorPlugin - constructor', () => {
    it('throws when no external source is provided', () => {
        expect(
            () =>
                new ReplicatorPlugin({
                    // @ts-expect-error testing runtime validation
                    external: undefined,
                    tables: [
                        {
                            name: 'users',
                            watermarkColumn: 'updated_at',
                            primaryKey: 'id',
                        },
                    ],
                })
        ).toThrow(/external source is required/)
    })

    it('throws when no tables are provided', () => {
        expect(
            () =>
                new ReplicatorPlugin({
                    external: externalSource,
                    tables: [],
                })
        ).toThrow(/At least one table/)
    })

    it('throws when a table is missing a required field', () => {
        expect(
            () =>
                new ReplicatorPlugin({
                    external: externalSource,
                    tables: [
                        // @ts-expect-error testing runtime validation
                        { name: 'users', watermarkColumn: 'updated_at' },
                    ],
                })
        ).toThrow(/name, watermarkColumn and primaryKey/)
    })
})

describe('ReplicatorPlugin - register()', () => {
    it('creates the replication state table on registration', async () => {
        const plugin = new ReplicatorPlugin({
            external: externalSource,
            tables: [
                {
                    name: 'users',
                    watermarkColumn: 'updated_at',
                    primaryKey: 'id',
                },
            ],
        })

        const middlewares: Array<(c: any, next: any) => Promise<void>> = []
        const mockApp = {
            use: vi.fn((mw) => middlewares.push(mw)),
            post: vi.fn(),
        } as any

        await plugin.register(mockApp)

        // Run the registered middleware to trigger init().
        await middlewares[0](
            {
                get: (key: string) =>
                    key === 'dataSource' ? dataSource : undefined,
            },
            vi.fn()
        )

        expect(executeQuery).toHaveBeenCalledWith({
            sql: expect.stringContaining(
                'CREATE TABLE IF NOT EXISTS tmp_replication_state'
            ),
            params: [],
        })
    })
})

describe('ReplicatorPlugin - sync()', () => {
    it('pulls rows from external and upserts them into internal storage', async () => {
        const plugin = new ReplicatorPlugin({
            external: externalSource,
            tables: [
                {
                    name: 'users',
                    watermarkColumn: 'updated_at',
                    primaryKey: 'id',
                },
            ],
        })

        executeQuery.mockImplementation(async ({ sql }: { sql: string }) => {
            if (sql.includes('SELECT last_value')) return []
            return []
        })

        mockExecuteSDKQuery.mockResolvedValueOnce([
            { id: 1, name: 'Alice', updated_at: '2024-01-01T00:00:00Z' },
            { id: 2, name: 'Bob', updated_at: '2024-01-02T00:00:00Z' },
        ])

        ;(plugin as any).dataSource = dataSource

        const results = await plugin.sync()

        expect(mockExecuteSDKQuery).toHaveBeenCalledTimes(1)
        const sdkCallArgs = mockExecuteSDKQuery.mock.calls[0][0]
        expect(sdkCallArgs.sql).toContain('SELECT * FROM "users"')
        expect(sdkCallArgs.sql).toContain('ORDER BY "updated_at" ASC')
        // No prior watermark — should not include a WHERE clause.
        expect(sdkCallArgs.sql).not.toContain('WHERE')

        const upsertCalls = executeQuery.mock.calls.filter((c: any[]) =>
            c[0].sql.includes('INSERT INTO "users"')
        )
        expect(upsertCalls).toHaveLength(2)
        expect(upsertCalls[0][0].sql).toContain(
            'ON CONFLICT("id") DO UPDATE SET'
        )

        const stateUpdates = executeQuery.mock.calls.filter((c: any[]) =>
            c[0].sql.includes('INSERT INTO tmp_replication_state')
        )
        expect(stateUpdates).toHaveLength(1)
        expect(stateUpdates[0][0].params[0]).toBe('users')
        expect(stateUpdates[0][0].params[1]).toBe('2024-01-02T00:00:00Z')

        expect(results).toEqual([
            {
                table: 'users',
                rowsReplicated: 2,
                lastValue: '2024-01-02T00:00:00Z',
            },
        ])
    })

    it('uses the stored watermark to fetch only newer rows', async () => {
        const plugin = new ReplicatorPlugin({
            external: externalSource,
            tables: [
                {
                    name: 'users',
                    watermarkColumn: 'updated_at',
                    primaryKey: 'id',
                },
            ],
        })

        executeQuery.mockImplementation(async ({ sql }: { sql: string }) => {
            if (sql.includes('SELECT last_value')) {
                return [{ last_value: '2024-01-02T00:00:00Z' }]
            }
            return []
        })

        mockExecuteSDKQuery.mockResolvedValueOnce([])
        ;(plugin as any).dataSource = dataSource

        const results = await plugin.sync()

        const sdkCallArgs = mockExecuteSDKQuery.mock.calls[0][0]
        expect(sdkCallArgs.sql).toContain('WHERE "updated_at" > ?')
        expect(sdkCallArgs.params).toEqual(['2024-01-02T00:00:00Z'])

        expect(results).toEqual([
            {
                table: 'users',
                rowsReplicated: 0,
                lastValue: '2024-01-02T00:00:00Z',
            },
        ])

        // No new rows were returned, so the state table should not be updated.
        const stateUpdates = executeQuery.mock.calls.filter((c: any[]) =>
            c[0].sql.includes('INSERT INTO tmp_replication_state')
        )
        expect(stateUpdates).toHaveLength(0)
    })

    it('writes rows to the configured destination table', async () => {
        const plugin = new ReplicatorPlugin({
            external: externalSource,
            tables: [
                {
                    name: 'orders',
                    watermarkColumn: 'id',
                    primaryKey: 'id',
                    destTable: 'orders_mirror',
                },
            ],
        })

        executeQuery.mockImplementation(async ({ sql }: { sql: string }) => {
            if (sql.includes('SELECT last_value')) return []
            return []
        })

        mockExecuteSDKQuery.mockResolvedValueOnce([{ id: 10, total: 99.5 }])
        ;(plugin as any).dataSource = dataSource

        await plugin.sync()

        const upsertCall = executeQuery.mock.calls.find((c: any[]) =>
            c[0].sql.startsWith('INSERT INTO "orders_mirror"')
        )
        expect(upsertCall).toBeDefined()
    })

    it('throws when the plugin has not been initialized', async () => {
        const plugin = new ReplicatorPlugin({
            external: externalSource,
            tables: [
                {
                    name: 'users',
                    watermarkColumn: 'updated_at',
                    primaryKey: 'id',
                },
            ],
        })

        await expect(plugin.sync()).rejects.toThrow(/not properly initialized/)
    })

    it('tracks numeric watermarks numerically (not lexicographically)', async () => {
        const plugin = new ReplicatorPlugin({
            external: externalSource,
            tables: [
                {
                    name: 'orders',
                    watermarkColumn: 'id',
                    primaryKey: 'id',
                },
            ],
        })

        executeQuery.mockImplementation(async ({ sql }: { sql: string }) => {
            if (sql.includes('SELECT last_value')) return []
            return []
        })

        // Rows arrive in ASC order. A naive string compare would say
        // "9" > "10" > "100", leaving 9 as the watermark and re-pulling rows
        // forever. The numeric path should pick 100.
        mockExecuteSDKQuery.mockResolvedValueOnce([
            { id: 9 },
            { id: 10 },
            { id: 100 },
        ])

        ;(plugin as any).dataSource = dataSource

        const results = await plugin.sync()

        expect(results[0].lastValue).toBe('100')
        const stateUpdates = executeQuery.mock.calls.filter((c: any[]) =>
            c[0].sql.includes('INSERT INTO tmp_replication_state')
        )
        expect(stateUpdates).toHaveLength(1)
        expect(stateUpdates[0][0].params[1]).toBe('100')
    })

    it('uses backtick quoting for the mysql dialect', async () => {
        const plugin = new ReplicatorPlugin({
            external: {
                dialect: 'mysql',
                host: 'localhost',
                port: 3306,
                user: 'u',
                password: 'p',
                database: 'd',
            },
            tables: [
                {
                    name: 'users',
                    watermarkColumn: 'updated_at',
                    primaryKey: 'id',
                },
            ],
        })

        executeQuery.mockImplementation(async ({ sql }: { sql: string }) => {
            if (sql.includes('SELECT last_value')) return []
            return []
        })
        mockExecuteSDKQuery.mockResolvedValueOnce([])
        ;(plugin as any).dataSource = dataSource

        await plugin.sync()

        const sdkCallArgs = mockExecuteSDKQuery.mock.calls[0][0]
        expect(sdkCallArgs.sql).toContain('SELECT * FROM `users`')
        expect(sdkCallArgs.sql).toContain('ORDER BY `updated_at` ASC')
    })
})

describe('ReplicatorPlugin - identifier validation', () => {
    it('rejects unsafe identifiers in the constructor', () => {
        expect(
            () =>
                new ReplicatorPlugin({
                    external: externalSource,
                    tables: [
                        {
                            name: 'users; DROP TABLE foo',
                            watermarkColumn: 'updated_at',
                            primaryKey: 'id',
                        },
                    ],
                })
        ).toThrow(/Invalid table name/)

        expect(
            () =>
                new ReplicatorPlugin({
                    external: externalSource,
                    tables: [
                        {
                            name: 'users',
                            watermarkColumn: 'updated at',
                            primaryKey: 'id',
                        },
                    ],
                })
        ).toThrow(/Invalid watermarkColumn/)
    })
})
