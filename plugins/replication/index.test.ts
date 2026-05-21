import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ReplicationPlugin } from './index'

// Mock the operation module
vi.mock('../../src/operation', () => ({
    executeExternalQuery: vi.fn(),
}))

vi.mock('../../src/utils', () => ({
    createResponse: vi.fn(
        (data, message, status) =>
            new Response(JSON.stringify({ result: data, error: message }), {
                status,
                headers: { 'Content-Type': 'application/json' },
            })
    ),
}))

import { executeExternalQuery } from '../../src/operation'

let plugin: ReplicationPlugin
let internalDb: Map<string, any[]>
let mockRpc: any
let mockDataSource: any
let mockConfig: any

beforeEach(() => {
    vi.clearAllMocks()
    internalDb = new Map()

    // Track SQL operations for verification
    const executedQueries: { sql: string; params?: unknown[] }[] = []

    mockRpc = {
        executeQuery: vi.fn(async (opts: any) => {
            executedQueries.push(opts)

            if (opts.sql.includes('CREATE TABLE IF NOT EXISTS')) {
                return []
            }
            if (opts.sql.includes('INSERT INTO tmp_replication_config') || opts.sql.includes('INSERT OR REPLACE')) {
                return []
            }
            if (opts.sql.includes('DELETE FROM tmp_replication_config')) {
                return []
            }
            if (opts.sql.includes('DELETE FROM tmp_replication_state')) {
                return []
            }
            if (opts.sql.includes('SELECT') && opts.sql.includes('tmp_replication_config')) {
                if (opts.sql.includes('LEFT JOIN')) {
                    // GET_ALL_CONFIGS
                    return [
                        {
                            table_name: 'users',
                            cursor_column: 'id',
                            interval: 60,
                            last_cursor: '5',
                            last_sync_at: '2026-05-21 12:00:00',
                            row_count: 5,
                        },
                    ]
                }
                if (opts.params?.[0]) {
                    return [{ table_name: opts.params[0], cursor_column: 'id', interval: 60 }]
                }
                return []
            }
            if (opts.sql.includes('tmp_replication_state') && opts.sql.includes('INSERT')) {
                return []
            }
            if (opts.sql.includes('tmp_replication_state') && opts.sql.includes('SELECT')) {
                return [{ last_cursor: '5', last_sync_at: '2026-05-21 12:00:00', row_count: 5 }]
            }
            return []
        }),
        setAlarm: vi.fn(),
        getAlarm: vi.fn().mockResolvedValue(null),
    }

    mockDataSource = {
        source: 'internal',
        external: { dialect: 'postgresql' },
        rpc: mockRpc,
    }

    mockConfig = {
        outerbaseApiKey: '',
        role: 'admin',
        features: {},
    }

    plugin = new ReplicationPlugin()
})

describe('ReplicationPlugin', () => {
    describe('constructor', () => {
        it('should create plugin with correct name', () => {
            expect(plugin.name).toBe('starbasedb:replication')
        })

        it('should require auth', () => {
            expect(plugin.opts.requiresAuth).toBe(true)
        })
    })

    describe('syncTable logic', () => {
        it('should query external source with cursor when lastCursor is set', async () => {
            // Simulate external rows returned
            vi.mocked(executeExternalQuery).mockResolvedValue([
                { id: 6, name: 'Frank' },
                { id: 7, name: 'Grace' },
            ])

            // Access private method via any cast for testing
            const pluginAny = plugin as any
            pluginAny.dataSource = mockDataSource
            pluginAny.config = mockConfig

            const inserted = await pluginAny.syncTable('users', 'id', '5')

            expect(executeExternalQuery).toHaveBeenCalledWith(
                expect.objectContaining({
                    sql: expect.stringContaining('WHERE id > ?'),
                    params: ['5'],
                })
            )
            expect(inserted).toBe(2)
        })

        it('should query external source without cursor on first sync', async () => {
            vi.mocked(executeExternalQuery).mockResolvedValue([
                { id: 1, name: 'Alice' },
                { id: 2, name: 'Bob' },
                { id: 3, name: 'Charlie' },
            ])

            const pluginAny = plugin as any
            pluginAny.dataSource = mockDataSource
            pluginAny.config = mockConfig

            const inserted = await pluginAny.syncTable('users', 'id', null)

            expect(executeExternalQuery).toHaveBeenCalledWith(
                expect.objectContaining({
                    sql: expect.stringContaining('ORDER BY id ASC LIMIT 1000'),
                    params: [],
                })
            )
            expect(inserted).toBe(3)
        })

        it('should return 0 when no new rows exist', async () => {
            vi.mocked(executeExternalQuery).mockResolvedValue([])

            const pluginAny = plugin as any
            pluginAny.dataSource = mockDataSource
            pluginAny.config = mockConfig

            const inserted = await pluginAny.syncTable('users', 'id', '100')

            expect(inserted).toBe(0)
        })

        it('should create internal table on first sync', async () => {
            vi.mocked(executeExternalQuery).mockResolvedValue([
                { id: 1, name: 'Alice', email: 'alice@test.com' },
            ])

            const pluginAny = plugin as any
            pluginAny.dataSource = mockDataSource
            pluginAny.config = mockConfig

            await pluginAny.syncTable('new_table', 'id', null)

            // Should have called executeQuery with CREATE TABLE
            expect(mockRpc.executeQuery).toHaveBeenCalledWith(
                expect.objectContaining({
                    sql: expect.stringContaining('CREATE TABLE IF NOT EXISTS "new_table"'),
                })
            )
        })

        it('should upsert rows with INSERT OR REPLACE', async () => {
            vi.mocked(executeExternalQuery).mockResolvedValue([
                { id: 1, name: 'Alice' },
            ])

            const pluginAny = plugin as any
            pluginAny.dataSource = mockDataSource
            pluginAny.config = mockConfig

            await pluginAny.syncTable('users', 'id', null)

            expect(mockRpc.executeQuery).toHaveBeenCalledWith(
                expect.objectContaining({
                    sql: expect.stringContaining('INSERT OR REPLACE INTO "users"'),
                    params: [1, 'Alice'],
                })
            )
        })

        it('should update replication state after sync', async () => {
            vi.mocked(executeExternalQuery).mockResolvedValue([
                { id: 10, name: 'Latest' },
            ])

            const pluginAny = plugin as any
            pluginAny.dataSource = mockDataSource
            pluginAny.config = mockConfig

            await pluginAny.syncTable('users', 'id', '5')

            // Should have updated state with new cursor
            expect(mockRpc.executeQuery).toHaveBeenCalledWith(
                expect.objectContaining({
                    sql: expect.stringContaining('tmp_replication_state'),
                    params: expect.arrayContaining(['users', '10']),
                })
            )
        })
    })

    describe('syncAllTables', () => {
        it('should sync all configured tables', async () => {
            vi.mocked(executeExternalQuery).mockResolvedValue([
                { id: 6, name: 'New User' },
            ])

            const pluginAny = plugin as any
            pluginAny.dataSource = mockDataSource
            pluginAny.config = mockConfig

            const results = await pluginAny.syncAllTables()

            expect(results).toHaveLength(1)
            expect(results[0].table).toBe('users')
            expect(results[0].inserted).toBe(1)
        })

        it('should handle errors per table without failing all', async () => {
            vi.mocked(executeExternalQuery).mockRejectedValue(
                new Error('Connection timeout')
            )

            const pluginAny = plugin as any
            pluginAny.dataSource = mockDataSource
            pluginAny.config = mockConfig

            const results = await pluginAny.syncAllTables()

            expect(results).toHaveLength(1)
            expect(results[0].error).toBe('Connection timeout')
            expect(results[0].inserted).toBe(0)
        })
    })

    describe('onAlarm', () => {
        it('should sync tables and reschedule alarm', async () => {
            vi.mocked(executeExternalQuery).mockResolvedValue([])

            const pluginAny = plugin as any
            pluginAny.dataSource = mockDataSource
            pluginAny.config = mockConfig

            await plugin.onAlarm()

            // Should have called setAlarm to reschedule
            expect(mockRpc.setAlarm).toHaveBeenCalled()
        })

        it('should warn when no external source configured', async () => {
            const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

            const pluginAny = plugin as any
            pluginAny.dataSource = { ...mockDataSource, external: undefined }
            pluginAny.config = mockConfig

            await plugin.onAlarm()

            expect(consoleSpy).toHaveBeenCalledWith(
                expect.stringContaining('no external source configured')
            )
        })
    })

    describe('scheduleNextAlarm', () => {
        it('should schedule alarm based on shortest interval', async () => {
            const pluginAny = plugin as any
            pluginAny.dataSource = mockDataSource
            pluginAny.config = mockConfig

            await pluginAny.scheduleNextAlarm()

            expect(mockRpc.setAlarm).toHaveBeenCalledWith(
                expect.any(Number)
            )

            // Verify the alarm is roughly 60 seconds in the future (the mocked interval)
            const alarmTime = mockRpc.setAlarm.mock.calls[0][0]
            const expectedMin = Date.now() + 59_000
            const expectedMax = Date.now() + 61_000
            expect(alarmTime).toBeGreaterThanOrEqual(expectedMin)
            expect(alarmTime).toBeLessThanOrEqual(expectedMax)
        })
    })
})
