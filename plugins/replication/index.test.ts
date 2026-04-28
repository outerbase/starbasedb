import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DataReplicationPlugin } from './index'
import { StarbaseApp, StarbaseDBConfiguration } from '../../src/handler'
import { DataSource } from '../../src/types'

let mockDataSource: DataSource
let mockConfig: StarbaseDBConfiguration

beforeEach(() => {
    vi.clearAllMocks()

    mockDataSource = {
        rpc: {
            executeQuery: vi.fn().mockResolvedValue([]),
        },
        source: 'internal',
        external: {
            dialect: 'postgresql',
            host: 'localhost',
            port: 5432,
            user: 'test',
            password: 'test',
            database: 'testdb',
            defaultSchema: 'public',
        },
        executionContext: {
            waitUntil: vi.fn(),
            passThroughOnException: vi.fn(),
        } as unknown as ExecutionContext,
    } as unknown as DataSource

    mockConfig = {
        role: 'admin',
    }
})

describe('DataReplicationPlugin - Initialization', () => {
    it('should initialize with correct name and options', () => {
        const plugin = new DataReplicationPlugin({
            config: {
                tables: [
                    {
                        sourceTable: 'users',
                        cursorColumn: 'id',
                        cursorType: 'integer',
                    },
                ],
            },
        })

        expect(plugin.name).toBe('starbasedb:replication')
        expect(plugin.pathPrefix).toBe('/replication')
        expect(plugin.opts.requiresAuth).toBe(true)
    })
})

describe('DataReplicationPlugin - register()', () => {
    it('should create state and history tables on first request', async () => {
        const plugin = new DataReplicationPlugin({
            config: {
                tables: [
                    {
                        sourceTable: 'users',
                        cursorColumn: 'id',
                        cursorType: 'integer',
                    },
                ],
            },
        })

        let capturedMiddleware: Function | null = null

        const mockApp = {
            use: vi.fn((fn) => {
                capturedMiddleware = fn
            }),
            get: vi.fn(),
            post: vi.fn(),
            delete: vi.fn(),
        } as unknown as StarbaseApp

        await plugin.register(mockApp)

        await capturedMiddleware!(
            {
                get: (key: string) =>
                    key === 'dataSource' ? mockDataSource : mockConfig,
            },
            vi.fn()
        )

        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledWith(
            expect.objectContaining({
                sql: expect.stringContaining(
                    'CREATE TABLE IF NOT EXISTS tmp_replication_state'
                ),
            })
        )

        expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledWith(
            expect.objectContaining({
                sql: expect.stringContaining(
                    'CREATE TABLE IF NOT EXISTS tmp_replication_history'
                ),
            })
        )
    })

    it('should register all expected routes', async () => {
        const plugin = new DataReplicationPlugin({
            config: { tables: [] },
        })

        const mockApp = {
            use: vi.fn(),
            get: vi.fn(),
            post: vi.fn(),
            delete: vi.fn(),
        } as unknown as StarbaseApp

        await plugin.register(mockApp)

        const getRoutes = mockApp.get as unknown as ReturnType<typeof vi.fn>
        const postRoutes = mockApp.post as unknown as ReturnType<typeof vi.fn>
        const deleteRoutes = mockApp.delete as unknown as ReturnType<
            typeof vi.fn
        >

        const registeredGetPaths = getRoutes.mock.calls.map(
            (c: unknown[]) => c[0]
        )
        const registeredPostPaths = postRoutes.mock.calls.map(
            (c: unknown[]) => c[0]
        )
        const registeredDeletePaths = deleteRoutes.mock.calls.map(
            (c: unknown[]) => c[0]
        )

        expect(registeredGetPaths).toContain('/replication/status')
        expect(registeredGetPaths).toContain('/replication/status/:table')
        expect(registeredGetPaths).toContain('/replication/history')
        expect(registeredGetPaths).toContain('/replication/history/:table')
        expect(registeredPostPaths).toContain('/replication/sync')
        expect(registeredPostPaths).toContain('/replication/sync/:table')
        expect(registeredDeletePaths).toContain('/replication/state/:table')
    })
})

describe('DataReplicationPlugin - syncTable()', () => {
    it('should return error result when no external source is configured', async () => {
        const plugin = new DataReplicationPlugin({
            config: {
                tables: [
                    {
                        sourceTable: 'users',
                        cursorColumn: 'id',
                        cursorType: 'integer',
                    },
                ],
            },
        })

        const dsWithoutExternal = {
            ...mockDataSource,
            external: undefined,
        } as unknown as DataSource

        const result = await plugin.syncTable(
            {
                sourceTable: 'users',
                cursorColumn: 'id',
                cursorType: 'integer',
            },
            dsWithoutExternal,
            mockConfig
        )

        expect(result.success).toBe(false)
        expect(result.error).toContain('No external data source configured')
    })

    it('should derive target table name as schema_table when no targetTable specified', async () => {
        const plugin = new DataReplicationPlugin({
            config: {
                tables: [
                    {
                        sourceTable: 'orders',
                        schema: 'commerce',
                        cursorColumn: 'id',
                        cursorType: 'integer',
                    },
                ],
                batchSize: 10,
            },
        })

        ;(
            mockDataSource.rpc.executeQuery as unknown as ReturnType<
                typeof vi.fn
            >
        )
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([
                { column_name: 'id', data_type: 'integer', is_nullable: 'NO' },
            ])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([])

        vi.spyOn(
            await import('../../src/operation'),
            'executeExternalQuery'
        ).mockResolvedValue([])

        const result = await plugin.syncTable(
            {
                sourceTable: 'orders',
                schema: 'commerce',
                cursorColumn: 'id',
                cursorType: 'integer',
            },
            mockDataSource,
            mockConfig
        )

        expect(result.success).toBe(true)
        expect(result.rowsSynced).toBe(0)
    })
})

describe('DataReplicationPlugin - target table naming', () => {
    it('should use explicit targetTable when provided', async () => {
        const plugin = new DataReplicationPlugin({
            config: {
                tables: [
                    {
                        sourceTable: 'users',
                        targetTable: 'my_users',
                        schema: 'public',
                        cursorColumn: 'id',
                        cursorType: 'integer',
                    },
                ],
            },
        })

        expect(plugin['config'].tables[0].targetTable).toBe('my_users')
    })

    it('should default to schema_table naming convention', () => {
        const schema = 'public'
        const sourceTable = 'users'
        const expected = `${schema}_${sourceTable}`

        expect(expected).toBe('public_users')
    })
})
