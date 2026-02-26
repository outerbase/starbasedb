import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StarbaseDBConfiguration } from '../../src/handler'
import type { DataSource } from '../../src/types'
import {
    ensureDataSyncTables,
    runDataSyncTask,
    upsertDataSyncTask,
} from './service'
import { executeExternalQuery, executeTransaction } from '../../src/operation'

vi.mock('../../src/operation', () => ({
    executeTransaction: vi.fn(),
    executeExternalQuery: vi.fn(),
}))

function createDataSource(): DataSource {
    return {
        source: 'internal',
        external: {
            dialect: 'postgresql',
            host: 'localhost',
            port: 5432,
            user: 'user',
            password: 'pass',
            database: 'db',
        },
        rpc: {} as any,
    } as DataSource
}

const externalConfig: StarbaseDBConfiguration = {
    role: 'admin',
    outerbaseApiKey: 'api-key',
    features: {},
}

describe('DataSync service', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('runs first sync without cursor predicate and forwards config', async () => {
        vi.mocked(executeTransaction).mockImplementation(async ({ queries }) => {
            const sql = queries[0].sql

            if (
                sql.includes('FROM tmp_data_sync_tasks') &&
                sql.includes('WHERE name = ?')
            ) {
                return [
                    [
                        {
                            name: 'users_sync',
                            source_table: 'users',
                            source_schema: null,
                            target_table: 'users_cache',
                            cursor_column: 'id',
                            cron_tab: '*/5 * * * *',
                            batch_size: 250,
                            last_cursor_value: null,
                            last_synced_at: null,
                        },
                    ],
                ]
            }

            if (sql.includes('SELECT last_insert_rowid() AS id')) {
                return [[{ id: 1 }]]
            }

            return [[]]
        })

        vi.mocked(executeExternalQuery).mockResolvedValue([])

        const summary = await runDataSyncTask(
            createDataSource(),
            'users_sync',
            externalConfig
        )

        expect(summary.syncedRows).toBe(0)

        const externalCall = vi.mocked(executeExternalQuery).mock.calls[0]?.[0]
        expect(externalCall).toBeDefined()
        expect(externalCall.config).toBe(externalConfig)
        expect(externalCall.sql).toContain('ORDER BY "id" ASC LIMIT ?')
        expect(externalCall.sql).not.toContain('WHERE "id" > ?')
        expect(externalCall.params).toEqual([250])
    })

    it('uses cursor predicate when checkpoint exists', async () => {
        vi.mocked(executeTransaction).mockImplementation(async ({ queries }) => {
            const sql = queries[0].sql

            if (
                sql.includes('FROM tmp_data_sync_tasks') &&
                sql.includes('WHERE name = ?')
            ) {
                return [
                    [
                        {
                            name: 'users_sync',
                            source_table: 'users',
                            source_schema: 'public',
                            target_table: 'users_cache',
                            cursor_column: 'id',
                            cron_tab: '*/5 * * * *',
                            batch_size: 100,
                            last_cursor_value: '123',
                            last_synced_at: 1,
                        },
                    ],
                ]
            }

            if (sql.includes('SELECT last_insert_rowid() AS id')) {
                return [[{ id: 1 }]]
            }

            return [[]]
        })

        vi.mocked(executeExternalQuery).mockResolvedValue([])

        await runDataSyncTask(createDataSource(), 'users_sync', externalConfig)

        const externalCall = vi.mocked(executeExternalQuery).mock.calls[0]?.[0]
        expect(externalCall.sql).toContain('FROM "public"."users"')
        expect(externalCall.sql).toContain('WHERE "id" > ?')
        expect(externalCall.params).toEqual([123, 100])
    })

    it('creates unique index and expands target schema before upsert', async () => {
        const executedSql: string[] = []

        vi.mocked(executeTransaction).mockImplementation(async ({ queries }) => {
            const sql = queries[0].sql
            executedSql.push(sql)

            if (
                sql.includes('FROM tmp_data_sync_tasks') &&
                sql.includes('WHERE name = ?')
            ) {
                return [
                    [
                        {
                            name: 'users_sync',
                            source_table: 'users',
                            source_schema: null,
                            target_table: 'users_cache',
                            cursor_column: 'id',
                            cron_tab: '*/5 * * * *',
                            batch_size: 50,
                            last_cursor_value: null,
                            last_synced_at: null,
                        },
                    ],
                ]
            }

            if (sql.includes('SELECT last_insert_rowid() AS id')) {
                return [[{ id: 99 }]]
            }

            if (sql.includes("SELECT name FROM sqlite_master WHERE type='table'")) {
                return [[]]
            }

            if (sql.includes('PRAGMA table_info("users_cache")')) {
                return [[{ name: 'id' }]]
            }

            return [[]]
        })

        vi.mocked(executeExternalQuery).mockResolvedValue([
            { id: 1, name: 'Alice', age: 32 },
        ])

        const summary = await runDataSyncTask(
            createDataSource(),
            'users_sync',
            externalConfig
        )

        expect(summary.syncedRows).toBe(1)
        expect(
            executedSql.some((sql) =>
                sql.includes(
                    'CREATE UNIQUE INDEX IF NOT EXISTS "tmp_data_sync_users_cache_id_uniq_idx"'
                )
            )
        ).toBe(true)
        expect(
            executedSql.some((sql) =>
                sql.includes('ALTER TABLE "users_cache" ADD COLUMN "name" TEXT;')
            )
        ).toBe(true)
        expect(
            executedSql.some((sql) =>
                sql.includes('ALTER TABLE "users_cache" ADD COLUMN "age" INTEGER;')
            )
        ).toBe(true)
    })

    it('uses internal admin config when creating metadata tables', async () => {
        vi.mocked(executeTransaction).mockResolvedValue([[]])

        await ensureDataSyncTables(createDataSource())

        expect(vi.mocked(executeTransaction)).toHaveBeenCalled()
        const firstConfig = vi.mocked(executeTransaction).mock.calls[0]?.[0]
            .config as StarbaseDBConfiguration

        expect(firstConfig.role).toBe('admin')
        expect(firstConfig.features?.allowlist).toBe(false)
        expect(firstConfig.features?.rls).toBe(false)
    })

    it('validates sync task and persists with clamped batch size', async () => {
        vi.mocked(executeTransaction).mockResolvedValue([[]])

        const result = await upsertDataSyncTask(createDataSource(), {
            name: 'nightly_users_sync',
            sourceTable: 'users',
            targetTable: 'users_cache',
            cursorColumn: 'id',
            intervalCron: '*/10 * * * *',
            batchSize: 999999,
        })

        expect(result.batchSize).toBe(2000)
        expect(result.name).toBe('nightly_users_sync')
    })
})
