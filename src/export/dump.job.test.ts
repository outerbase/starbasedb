import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runDumpJob, dumpJobStatus, type DumpEngineHost } from './dump'
import { executeOperation } from './index'
import {
    DUMP_STATE_KEY,
    MIN_R2_PART_SIZE_BYTES,
    type DumpState,
} from './chunkedDump'
import type { DataSource } from '../types'
import type { StarbaseDBConfiguration } from '../handler'

vi.mock('./index', () => ({
    executeOperation: vi.fn(),
}))

const makeStorage = () => {
    const values = new Map<string, unknown>()
    return {
        get: vi.fn(async <T>(key: string) => values.get(key) as T),
        put: vi.fn(async (key: string, value: unknown) => {
            values.set(key, value)
        }),
        delete: vi.fn(async (key: string) => {
            values.delete(key)
        }),
    }
}

const makeDataSource = (): DataSource =>
    ({ source: 'internal', rpc: {} }) as unknown as DataSource

const makeConfig = (): StarbaseDBConfiguration => ({ role: 'admin' })

const makeHost = () => {
    const alarms: number[] = []
    const host: DumpEngineHost = {
        storage: makeStorage() as unknown as DurableObjectStorage,
        env: {},
        dataSource: makeDataSource(),
        config: makeConfig(),
        setAlarm: vi.fn(async (time: number) => {
            alarms.push(time)
        }),
    }
    return { host, alarms }
}

const setupCompleteQueries = () => {
    vi.mocked(executeOperation).mockImplementation(async (queries: any[]) => {
        const query = queries[0]
        const sql: string = query.sql
        const params: unknown[] = query.params ?? []
        if (sql.includes('sqlite_master') && sql.includes('name NOT LIKE')) {
            return [{ name: 't' }]
        }
        if (sql.includes('SELECT sql FROM sqlite_master')) {
            return [{ sql: 'CREATE TABLE t (id INTEGER)' }]
        }
        if (sql.includes('PRAGMA table_info')) {
            return [{ name: 'id', pk: 1 }]
        }
        if (sql.includes('LIMIT 0')) {
            return []
        }
        if (sql.includes('ORDER BY')) {
            return params.length === 0
                ? [{ __starbase_dump_cursor_0: 1, id: 1 }]
                : []
        }
        return []
    })
}

describe('dump job lifecycle', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('reuses a completed job instead of planning a second dump', async () => {
        setupCompleteQueries()
        const { host } = makeHost()
        const fetchSpy = vi.spyOn(globalThis, 'fetch')

        const first = await runDumpJob(
            host,
            new URLSearchParams({
                callbackUrl: 'https://example.invalid/callback',
            })
        )
        const firstText = await first.text()
        const firstState = (await host.storage.get(DUMP_STATE_KEY)) as DumpState
        const planCallsAfterFirst = vi
            .mocked(executeOperation)
            .mock.calls.filter(([queries]) =>
                String((queries as any[])[0].sql).includes('name NOT LIKE')
            ).length

        const second = await runDumpJob(host, new URLSearchParams())
        const secondText = await second.text()
        const secondState = (await host.storage.get(
            DUMP_STATE_KEY
        )) as DumpState
        const planCallsAfterSecond = vi
            .mocked(executeOperation)
            .mock.calls.filter(([queries]) =>
                String((queries as any[])[0].sql).includes('name NOT LIKE')
            ).length
        const status = await dumpJobStatus(host)

        expect(first.status).toBe(200)
        expect(second.status).toBe(200)
        expect(secondText).toBe(firstText)
        expect(secondState.dumpId).toBe(firstState.dumpId)
        expect(planCallsAfterSecond).toBe(planCallsAfterFirst)
        expect(status.status).toBe(200)
        expect(await status.text()).toBe(firstText)
        expect(fetchSpy).not.toHaveBeenCalled()
        expect('callbackUrl' in firstState).toBe(false)
        fetchSpy.mockRestore()
    })

    it('normalizes the part size in persisted job state', async () => {
        setupCompleteQueries()
        const { host } = makeHost()
        const response = await runDumpJob(
            host,
            new URLSearchParams({ partBytes: '1' })
        )
        await response.arrayBuffer()
        const state = (await host.storage.get(DUMP_STATE_KEY)) as DumpState

        expect(state.finalizePartSizeBytes).toBe(MIN_R2_PART_SIZE_BYTES)
    })

    it('returns a resumable response and schedules the next cycle when work remains', async () => {
        setupCompleteQueries()
        const { host, alarms } = makeHost()
        const response = await runDumpJob(
            host,
            new URLSearchParams({ chunkBytes: '1' }),
            Date.now() - 10_000
        )
        const body = (await response.json()) as {
            result: { status: string }
        }

        expect(response.status).toBe(202)
        expect(body.result.status).toBe('in-progress')
        expect(alarms.length).toBeGreaterThan(0)
    })
})
