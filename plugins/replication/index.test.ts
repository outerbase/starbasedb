import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ReplicationPlugin } from './index'
import { executeQuery } from '../../src/operation'
import type { DataSource } from '../../src/types'

vi.mock('../../src/operation', () => ({
    executeQuery: vi.fn(),
}))

describe('ReplicationPlugin', () => {
    let plugin: ReplicationPlugin
    let dataSource: DataSource

    beforeEach(() => {
        vi.clearAllMocks()

        plugin = new ReplicationPlugin()

        dataSource = {
            source: 'internal',
            external: {
                dialect: 'postgresql',
                host: 'localhost',
                port: 5432,
                user: 'postgres',
                password: 'postgres',
                database: 'postgres',
            },
            rpc: {
                executeQuery: vi.fn().mockResolvedValue([]),
                setAlarm: vi.fn(),
            },
        } as unknown as DataSource
        ;(plugin as any).dataSource = dataSource
        ;(plugin as any).config = { role: 'admin', features: {} }
    })

    it('validates task input identifiers', () => {
        const valid = (plugin as any).validateTaskInput({
            sourceTable: 'orders',
            targetTable: 'orders_cache',
            cursorColumn: 'id',
        })

        expect(valid.valid).toBe(true)

        const invalid = (plugin as any).validateTaskInput({
            sourceTable: 'orders;DROP',
            cursorColumn: 'id',
        })

        expect(invalid.valid).toBe(false)
    })

    it('fails runTask when external source is missing', async () => {
        ;(plugin as any).dataSource = {
            source: 'internal',
            rpc: {
                executeQuery: vi.fn(),
                setAlarm: vi.fn(),
            },
        } as unknown as DataSource

        const result = await (plugin as any).runTask('task-1')

        expect(result.success).toBe(false)
        expect(result.message).toContain('External data source is required')
    })

    it('fails runTask when task does not exist', async () => {
        vi.mocked(dataSource.rpc.executeQuery as any).mockResolvedValueOnce([])

        const result = await (plugin as any).runTask('missing-task')

        expect(result.success).toBe(false)
        expect(result.message).toContain('Replication task not found')
    })

    it('syncs rows and updates cursor state on success', async () => {
        const taskRow = {
            id: 'task-1',
            source_table: 'orders',
            target_table: 'orders',
            cursor_column: 'id',
            cursor_value: null,
            interval_seconds: 60,
            batch_size: 2,
            next_run_at: Date.now(),
            is_active: 1,
            callback_host: 'https://example.com',
            last_error: null,
            created_at: Date.now(),
            updated_at: Date.now(),
        }

        vi.mocked(dataSource.rpc.executeQuery as any)
            .mockResolvedValueOnce([taskRow])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([])

        vi.mocked(executeQuery as any).mockResolvedValue([
            { id: 10, item: 'A' },
            { id: 11, item: 'B' },
        ])

        const result = await (plugin as any).runTask('task-1')

        expect(result.success).toBe(true)
        expect(result.rowsSynced).toBe(2)
        expect(dataSource.rpc.executeQuery).toHaveBeenCalledWith(
            expect.objectContaining({
                sql: expect.stringContaining('INSERT OR REPLACE INTO orders'),
            })
        )
        expect(dataSource.rpc.executeQuery).toHaveBeenCalledWith(
            expect.objectContaining({
                sql: expect.stringContaining('UPDATE tmp_replication_tasks'),
            })
        )
    })
})
