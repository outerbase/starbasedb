import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ReplicationPlugin } from './index'
import { StarbaseDBConfiguration } from '../../src/handler'
import { DataSource } from '../../src/types'

let mockConfig: StarbaseDBConfiguration
let mockDataSource: DataSource
let executeQuery: ReturnType<typeof vi.fn>
let externalExecutor: ReturnType<typeof vi.fn>
let stateRows: any[]

beforeEach(() => {
    stateRows = []
    executeQuery = vi.fn(async ({ sql }) => {
        if (
            sql.includes('FROM tmp_starbasedb_replication_state') &&
            sql.includes('WHERE table_name = ?')
        ) {
            return stateRows
        }

        return []
    })
    externalExecutor = vi.fn()
    mockConfig = { role: 'admin' }
    mockDataSource = {
        source: 'internal',
        external: {
            dialect: 'postgresql',
            host: 'db.example.com',
            port: 5432,
            user: 'postgres',
            password: 'password',
            database: 'app',
        },
        rpc: {
            executeQuery,
        },
    } as unknown as DataSource
})

describe('ReplicationPlugin', () => {
    it('pulls external rows into the internal table and advances cursor state', async () => {
        externalExecutor.mockResolvedValue([
            { id: 1, email: 'a@example.com', updated_at: '2026-05-14T00:00:00Z' },
            { id: 2, email: 'b@example.com', updated_at: '2026-05-15T00:00:00Z' },
        ])
        const plugin = new ReplicationPlugin({
            defaultIntervalSeconds: 0,
            externalExecutor,
            tables: [
                {
                    sourceTable: 'public.users',
                    targetTable: 'users',
                    columns: ['id', 'email', 'updated_at'],
                    cursorColumn: 'updated_at',
                    cursorValueType: 'date',
                    primaryKey: 'id',
                    batchSize: 2,
                },
            ],
        })

        const result = await plugin.sync({
            dataSource: mockDataSource,
            config: mockConfig,
            force: true,
        })

        expect(externalExecutor).toHaveBeenCalledWith({
            sql: 'SELECT "id", "email", "updated_at" FROM "public"."users" ORDER BY "updated_at" ASC LIMIT 2',
            params: [],
            dataSource: mockDataSource,
            config: mockConfig,
        })
        expect(executeQuery).toHaveBeenCalledWith({
            sql: expect.stringContaining('ON CONFLICT ("id") DO UPDATE SET'),
            params: [1, 'a@example.com', '2026-05-14T00:00:00Z'],
        })
        expect(executeQuery).toHaveBeenCalledWith({
            sql: expect.stringContaining(
                'INSERT INTO tmp_starbasedb_replication_state'
            ),
            params: [
                'users',
                '2026-05-15T00:00:00Z',
                'date',
                expect.any(String),
                2,
            ],
        })
        expect(result).toEqual([
            expect.objectContaining({
                table: 'users',
                sourceTable: 'public.users',
                targetTable: 'users',
                skipped: false,
                rowsRead: 2,
                rowsWritten: 2,
                cursorEnd: '2026-05-15T00:00:00Z',
            }),
        ])
    })

    it('uses the stored cursor value for append-only polling', async () => {
        stateRows = [
            {
                table_name: 'events',
                last_cursor_value: '5',
                last_cursor_type: 'number',
                last_synced_at: '2026-05-15T00:00:00Z',
                total_rows_synced: 5,
            },
        ]
        externalExecutor.mockResolvedValue([{ id: 6, name: 'created' }])
        const plugin = new ReplicationPlugin({
            externalExecutor,
            tables: [
                {
                    sourceTable: 'events',
                    cursorColumn: 'id',
                    cursorValueType: 'number',
                    batchSize: 10,
                },
            ],
        })

        await plugin.sync({
            dataSource: mockDataSource,
            config: mockConfig,
            force: true,
        })

        expect(externalExecutor).toHaveBeenCalledWith(
            expect.objectContaining({
                sql: 'SELECT * FROM "events" WHERE "id" > ? ORDER BY "id" ASC LIMIT 10',
                params: [5],
            })
        )
    })

    it('skips auto sync when a table interval is not due', async () => {
        stateRows = [
            {
                table_name: 'users',
                last_synced_at: new Date().toISOString(),
                total_rows_synced: 10,
            },
        ]
        const plugin = new ReplicationPlugin({
            externalExecutor,
            tables: [
                {
                    sourceTable: 'users',
                    intervalSeconds: 60,
                },
            ],
        })

        const result = await plugin.sync({
            dataSource: mockDataSource,
            config: mockConfig,
            force: false,
        })

        expect(externalExecutor).not.toHaveBeenCalled()
        expect(result).toEqual([
            expect.objectContaining({
                table: 'users',
                skipped: true,
                rowsRead: 0,
                rowsWritten: 0,
            }),
        ])
    })

    it('runs due replication in beforeQuery without modifying the user query', async () => {
        externalExecutor.mockResolvedValue([])
        const plugin = new ReplicationPlugin({
            externalExecutor,
            tables: [{ sourceTable: 'users', intervalSeconds: 0 }],
        })

        const result = await plugin.beforeQuery({
            sql: 'SELECT * FROM users',
            params: [1],
            dataSource: mockDataSource,
            config: mockConfig,
        })

        expect(externalExecutor).toHaveBeenCalledTimes(1)
        expect(result).toEqual({
            sql: 'SELECT * FROM users',
            params: [1],
        })
    })

    it('requires an internal target data source with an external source configured', async () => {
        const plugin = new ReplicationPlugin({
            externalExecutor,
            tables: [{ sourceTable: 'users' }],
        })

        await expect(
            plugin.sync({
                dataSource: { ...mockDataSource, source: 'external' } as any,
                config: mockConfig,
                force: true,
            })
        ).rejects.toThrow(
            'ReplicationPlugin can only write to an internal StarbaseDB data source.'
        )

        await expect(
            plugin.sync({
                dataSource: { ...mockDataSource, external: undefined } as any,
                config: mockConfig,
                force: true,
            })
        ).rejects.toThrow(
            'ReplicationPlugin requires dataSource.external to pull from an external source.'
        )
    })

    it('rejects unsafe table and column identifiers', () => {
        expect(
            () =>
                new ReplicationPlugin({
                    tables: [{ sourceTable: 'users; DROP TABLE users' }],
                })
        ).toThrow('Invalid SQL identifier')

        expect(
            () =>
                new ReplicationPlugin({
                    tables: [{ sourceTable: 'users', columns: ['id, name'] }],
                })
        ).toThrow('Invalid SQL identifier')
    })
})

