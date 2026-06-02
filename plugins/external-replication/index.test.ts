import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the two execution dependencies BEFORE importing the plugin (vi.mock is hoisted).
vi.mock('../../src/operation', () => ({
    executeExternalQuery: vi.fn(),
}))
vi.mock('../../src/export', () => ({
    executeOperation: vi.fn(),
}))

import { ExternalReplicationPlugin } from './index'
import { executeExternalQuery } from '../../src/operation'
import { executeOperation } from '../../src/export'
import { DataSource } from '../../src/types'
import { StarbaseDBConfiguration } from '../../src/handler'

const config = { role: 'admin' } as StarbaseDBConfiguration
const dataSource = {
    rpc: {},
    source: 'external',
    external: { dialect: 'postgresql' },
} as unknown as DataSource

function upsertCallFor(table: string) {
    return vi
        .mocked(executeOperation)
        .mock.calls.find(
            (args: any[]) =>
                Array.isArray(args[0]) &&
                typeof args[0][0]?.sql === 'string' &&
                args[0][0].sql.startsWith(`INSERT OR REPLACE INTO "${table}"`)
        )
}

beforeEach(() => {
    vi.clearAllMocks()
    // Default: internal state lookups return nothing -> cursor starts null.
    vi.mocked(executeOperation).mockResolvedValue([] as any)
})

describe('ExternalReplicationPlugin - buildSelectQuery', () => {
    const plugin = new ExternalReplicationPlugin()

    it('full snapshot when no cursorColumn', () => {
        const { sql, params } = plugin.buildSelectQuery({ name: 'users' }, null)
        expect(sql).toBe('SELECT * FROM "users" LIMIT 5000')
        expect(params).toEqual([])
    })

    it('incremental first run (cursor column, no saved cursor) omits WHERE', () => {
        const { sql, params } = plugin.buildSelectQuery(
            { name: 'users', cursorColumn: 'updated_at' },
            null
        )
        expect(sql).toBe(
            'SELECT * FROM "users" ORDER BY "updated_at" ASC LIMIT 5000'
        )
        expect(params).toEqual([])
    })

    it('incremental with saved cursor adds WHERE + param + custom batch', () => {
        const { sql, params } = plugin.buildSelectQuery(
            { name: 'users', cursorColumn: 'updated_at', batchSize: 100 },
            '2024-01-01'
        )
        expect(sql).toBe(
            'SELECT * FROM "users" WHERE "updated_at" > ? ORDER BY "updated_at" ASC LIMIT 100'
        )
        expect(params).toEqual(['2024-01-01'])
    })

    it('quotes identifiers defensively', () => {
        const { sql } = plugin.buildSelectQuery({ name: 'we"ird' }, null)
        expect(sql).toContain('"we""ird"')
    })
})

describe('ExternalReplicationPlugin - buildUpsertQueries', () => {
    const plugin = new ExternalReplicationPlugin()

    it('builds an idempotent INSERT OR REPLACE per row', () => {
        const writes = plugin.buildUpsertQueries('users', [
            { id: 1, name: 'Alice' },
            { id: 2, name: 'Bob' },
        ])
        expect(writes).toHaveLength(2)
        expect(writes[0].sql).toBe(
            'INSERT OR REPLACE INTO "users" ("id", "name") VALUES (?, ?)'
        )
        expect(writes[0].params).toEqual([1, 'Alice'])
        expect(writes[1].params).toEqual([2, 'Bob'])
    })
})

describe('ExternalReplicationPlugin - replicateTable', () => {
    it('pulls from external, upserts into internal, advances the cursor', async () => {
        const plugin = new ExternalReplicationPlugin()
        vi.mocked(executeExternalQuery).mockResolvedValue([
            { id: 5, name: 'Eve' },
            { id: 6, name: 'Frank' },
        ])

        const result = await plugin.replicateTable(
            { name: 'users', cursorColumn: 'id' },
            dataSource,
            config
        )

        expect(result).toEqual({ table: 'users', rowsReplicated: 2, cursor: 6 })
        expect(executeExternalQuery).toHaveBeenCalledTimes(1)

        const upsert = upsertCallFor('users')
        expect(upsert).toBeTruthy()
        expect(upsert![0]).toHaveLength(2)

        // cursor persisted to the state table
        const stateWrite = vi
            .mocked(executeOperation)
            .mock.calls.find((a: any[]) =>
                a[0]?.[0]?.sql?.includes('_starbasedb_replication_state')
            )
        expect(stateWrite).toBeTruthy()
    })

    it('no rows -> no upsert and rowsReplicated 0', async () => {
        const plugin = new ExternalReplicationPlugin()
        vi.mocked(executeExternalQuery).mockResolvedValue([])

        const result = await plugin.replicateTable(
            { name: 'users' },
            dataSource,
            config
        )

        expect(result.rowsReplicated).toBe(0)
        expect(upsertCallFor('users')).toBeFalsy()
    })

    it('resumes from a previously saved cursor', async () => {
        const plugin = new ExternalReplicationPlugin()
        // state lookup returns a saved cursor for this run
        vi.mocked(executeOperation).mockResolvedValueOnce([] as any) // ensureStateTable
        vi.mocked(executeOperation).mockResolvedValueOnce([
            { last_cursor: '100' },
        ] as any) // getLastCursor
        vi.mocked(executeExternalQuery).mockResolvedValue([{ id: 101 }])

        await plugin.replicateTable(
            { name: 'events', cursorColumn: 'id' },
            dataSource,
            config
        )

        const externalArgs = vi.mocked(executeExternalQuery).mock.calls[0][0]
        expect(externalArgs.sql).toContain('WHERE "id" > ?')
        expect(externalArgs.params).toEqual(['100'])
    })
})
