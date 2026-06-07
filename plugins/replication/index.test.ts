import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
    ReplicationPlugin,
    assertIdent,
    quoteIdent,
    clampBatch,
    buildPullQuery,
    toRowObjects,
    advanceCursor,
    inferSqliteType,
    serializeValue,
    parseJSONArray,
    redactConfig,
} from './index'
import { executeQuery } from '../../src/operation'

vi.mock('../../src/operation', () => ({
    executeQuery: vi.fn(),
}))

const mockExecuteQuery = vi.mocked(executeQuery)

// ── Fixtures ───────────────────────────────────────────────────────────────

function makeDataSource() {
    return {
        source: 'internal',
        rpc: {
            executeQuery: vi.fn().mockResolvedValue([]),
        },
        executionContext: { waitUntil: vi.fn() },
    } as any
}

const mockCron = {
    addEvent: vi.fn().mockResolvedValue(undefined),
    removeEvent: vi.fn().mockResolvedValue(undefined),
}

function jobRow(overrides: Record<string, unknown> = {}) {
    return {
        name: 'users_sync',
        source_config: JSON.stringify({
            dialect: 'postgresql',
            host: 'h',
            port: 5432,
            user: 'u',
            password: 'p',
            database: 'd',
        }),
        table_name: 'users',
        tracking_col: 'updated_at',
        tracking_type: 'timestamp',
        last_value: null,
        cron_tab: '*/5 * * * *',
        target_table: null,
        columns: null,
        primary_key: null,
        batch_size: 500,
        is_active: 1,
        last_run_at: null,
        last_error: null,
        rows_synced: 0,
        created_at: null,
        ...overrides,
    }
}

const VALID_BODY = {
    name: 'users_sync',
    table_name: 'users',
    tracking_col: 'updated_at',
    tracking_type: 'timestamp' as const,
    cron_tab: '*/5 * * * *',
    source: {
        dialect: 'postgresql' as const,
        host: 'h',
        port: 5432,
        user: 'u',
        password: 'p',
        database: 'd',
    },
}

function makeContext(opts: {
    body?: any
    param?: Record<string, string>
    url?: string
}) {
    return {
        req: {
            json: async () => opts.body,
            param: (key: string) => opts.param?.[key],
            url: opts.url ?? 'http://localhost:8787/replication/jobs',
        },
    } as any
}

function makePlugin(maxPagesPerRun = 50) {
    const plugin = new ReplicationPlugin({
        cron: mockCron as any,
        maxPagesPerRun,
    })
    const ds = makeDataSource()
    plugin['dataSource'] = ds
    plugin['config'] = { role: 'admin' } as any
    return { plugin, ds }
}

// Make GET_JOB return our row while every other internal query returns [].
function withJob(ds: any, row: Record<string, unknown>) {
    ds.rpc.executeQuery.mockImplementation(async ({ sql }: { sql: string }) =>
        sql.includes('SELECT * FROM tmp_replication_jobs') ? [row] : []
    )
}

beforeEach(() => {
    vi.clearAllMocks()
    mockExecuteQuery.mockReset()
})

// ── Pure helpers ─────────────────────────────────────────────────────────────

describe('assertIdent', () => {
    it('accepts safe identifiers including reserved words', () => {
        expect(() => assertIdent('users_2', 'table')).not.toThrow()
        expect(() => assertIdent('order', 'table')).not.toThrow()
    })

    it('rejects injection, spaces, empty and non-strings', () => {
        expect(() => assertIdent('users; DROP TABLE x', 'table')).toThrow()
        expect(() => assertIdent('a b', 'table')).toThrow()
        expect(() => assertIdent('', 'table')).toThrow()
        expect(() => assertIdent(undefined, 'table')).toThrow()
        expect(() => assertIdent('a"b', 'table')).toThrow()
    })
})

describe('quoteIdent', () => {
    it('quotes per dialect', () => {
        expect(quoteIdent('col', 'postgresql')).toBe('"col"')
        expect(quoteIdent('col', 'mysql')).toBe('`col`')
        expect(quoteIdent('col', 'sqlite')).toBe('"col"')
    })
})

describe('clampBatch', () => {
    it('defaults invalid input to 500', () => {
        expect(clampBatch(undefined)).toBe(500)
        expect(clampBatch(0)).toBe(500)
        expect(clampBatch(-3)).toBe(500)
        expect(clampBatch('abc')).toBe(500)
    })

    it('clamps and floors', () => {
        expect(clampBatch(50)).toBe(50)
        expect(clampBatch(999999)).toBe(10000)
        expect(clampBatch(12.9)).toBe(12)
    })
})

describe('buildPullQuery', () => {
    it('omits WHERE on the first run', () => {
        const sql = buildPullQuery(
            'users',
            'updated_at',
            null,
            false,
            500,
            'postgresql'
        )
        expect(sql).not.toContain('WHERE')
        expect(sql).toContain('SELECT * FROM "users"')
        expect(sql).toContain('ORDER BY "updated_at" ASC LIMIT 500')
    })

    it('adds a ? cursor predicate when a cursor exists', () => {
        const sql = buildPullQuery(
            'users',
            'updated_at',
            null,
            true,
            100,
            'postgresql'
        )
        expect(sql).toContain('WHERE "updated_at" > ?')
        expect(sql).not.toContain('$1')
    })

    it('selects an explicit column list and quotes per dialect', () => {
        const pg = buildPullQuery(
            'users',
            'id',
            ['id', 'name'],
            false,
            10,
            'postgresql'
        )
        expect(pg).toContain('SELECT "id", "name" FROM "users"')

        const my = buildPullQuery('users', 'id', ['id'], false, 10, 'mysql')
        expect(my).toContain('SELECT `id` FROM `users`')
        expect(my).toContain('ORDER BY `id` ASC')
    })
})

describe('toRowObjects', () => {
    it('maps {columns, rows} into row objects', () => {
        expect(
            toRowObjects({
                columns: ['id', 'name'],
                rows: [
                    [1, 'a'],
                    [2, 'b'],
                ],
            })
        ).toEqual([
            { id: 1, name: 'a' },
            { id: 2, name: 'b' },
        ])
    })

    it('passes through an array of objects and handles empties', () => {
        expect(toRowObjects([{ id: 1 }])).toEqual([{ id: 1 }])
        expect(toRowObjects(undefined)).toEqual([])
        expect(toRowObjects({ columns: [], rows: [] })).toEqual([])
    })
})

describe('advanceCursor', () => {
    it('compares ids numerically', () => {
        const rows = [{ id: 9 }, { id: 10 }, { id: 2 }]
        expect(advanceCursor(null, rows, 'id', 'id')).toBe('10')
    })

    it('compares timestamps temporally and keeps the latest', () => {
        const rows = [
            { ts: '2024-01-01T00:00:00Z' },
            { ts: '2024-03-01T00:00:00Z' },
            { ts: '2024-02-01T00:00:00Z' },
        ]
        expect(advanceCursor(null, rows, 'ts', 'timestamp')).toBe(
            '2024-03-01T00:00:00Z'
        )
    })

    it('never regresses below the previous cursor', () => {
        const rows = [{ id: 3 }]
        expect(advanceCursor('100', rows, 'id', 'id')).toBe('100')
    })

    it('skips null tracking values', () => {
        const rows = [{ id: null }, { id: 5 }]
        expect(advanceCursor(null, rows, 'id', 'id')).toBe('5')
    })

    it('serializes Date values to ISO', () => {
        const rows = [{ ts: new Date('2024-05-05T00:00:00Z') }]
        expect(advanceCursor(null, rows, 'ts', 'timestamp')).toBe(
            '2024-05-05T00:00:00.000Z'
        )
    })
})

describe('inferSqliteType', () => {
    it('maps JS values to SQLite affinities', () => {
        expect(inferSqliteType(1)).toBe('INTEGER')
        expect(inferSqliteType(1.5)).toBe('REAL')
        expect(inferSqliteType(true)).toBe('INTEGER')
        expect(inferSqliteType('x')).toBe('TEXT')
        expect(inferSqliteType({ a: 1 })).toBe('TEXT')
        expect(inferSqliteType(null)).toBe('TEXT')
    })
})

describe('serializeValue', () => {
    it('coerces values for SQLite binding', () => {
        expect(serializeValue(true)).toBe(1)
        expect(serializeValue(false)).toBe(0)
        expect(serializeValue(null)).toBe(null)
        expect(serializeValue(undefined)).toBe(null)
        expect(serializeValue({ a: 1 })).toBe('{"a":1}')
        expect(serializeValue([1, 2])).toBe('[1,2]')
        expect(serializeValue(new Date('2024-01-01T00:00:00Z'))).toBe(
            '2024-01-01T00:00:00.000Z'
        )
        expect(serializeValue('hello')).toBe('hello')
        expect(serializeValue(7)).toBe(7)
    })

    it('neutralizes non-finite numbers and binds bigint safely', () => {
        expect(serializeValue(NaN)).toBe(null)
        expect(serializeValue(Infinity)).toBe(null)
        expect(serializeValue(-Infinity)).toBe(null)
        expect(serializeValue(123n)).toBe(123)
        expect(serializeValue(9007199254740993n)).toBe('9007199254740993')
    })
})

describe('parseJSONArray', () => {
    it('parses arrays and rejects everything else', () => {
        expect(parseJSONArray('["a","b"]')).toEqual(['a', 'b'])
        expect(parseJSONArray(null)).toBe(null)
        expect(parseJSONArray('not json')).toBe(null)
        expect(parseJSONArray('{"a":1}')).toBe(null)
    })
})

describe('redactConfig', () => {
    it('masks the password', () => {
        const out = redactConfig(
            JSON.stringify({ host: 'h', password: 'secret' })
        )
        expect(JSON.parse(out).password).toBe('***')
        expect(JSON.parse(out).host).toBe('h')
    })

    it('returns the input unchanged when it cannot be parsed', () => {
        expect(redactConfig('not json')).toBe('not json')
    })
})

// ── Routes ───────────────────────────────────────────────────────────────────

describe('ReplicationPlugin - routes (admin gate)', () => {
    it('rejects non-admin callers on every mutating route', async () => {
        const { plugin } = makePlugin()
        plugin['config'] = { role: 'client' } as any

        for (const handler of [
            'handleCreateJob',
            'handleListJobs',
            'handleDeleteJob',
            'handleRunJob',
            'handleResetJob',
            'handlePatchJob',
        ]) {
            const res = await (plugin as any)[handler](
                makeContext({ body: VALID_BODY, param: { name: 'x' } })
            )
            expect(res.status).toBe(400)
            expect(await res.text()).toBe('Unauthorized request')
        }
    })
})

describe('ReplicationPlugin - handleCreateJob', () => {
    it('validates, upserts and schedules a cron task', async () => {
        const { plugin, ds } = makePlugin()
        const res = await plugin['handleCreateJob'](
            makeContext({
                body: VALID_BODY,
                url: 'http://example.com:8787/replication/jobs',
            })
        )

        expect(res.status).toBe(200)
        const upsert = ds.rpc.executeQuery.mock.calls.find((c: any) =>
            c[0].sql.includes('INSERT OR REPLACE INTO tmp_replication_jobs')
        )
        expect(upsert).toBeTruthy()
        expect(mockCron.addEvent).toHaveBeenCalledWith(
            '*/5 * * * *',
            'replication:users_sync',
            {},
            'http://example.com:8787',
            ds
        )
    })

    it('preserves cursor, counters and created_at on re-create', async () => {
        const { plugin, ds } = makePlugin()
        ds.rpc.executeQuery.mockImplementation(async ({ sql }: any) =>
            sql.includes('SELECT last_value, rows_synced, created_at')
                ? [{ last_value: '99', rows_synced: 42, created_at: '2020' }]
                : []
        )

        await plugin['handleCreateJob'](makeContext({ body: VALID_BODY }))
        const upsert = ds.rpc.executeQuery.mock.calls.find((c: any) =>
            c[0].sql.includes('INSERT OR REPLACE INTO tmp_replication_jobs')
        )
        expect(upsert[0].params[5]).toBe('99') // last_value
        expect(upsert[0].params[14]).toBe(42) // rows_synced
        expect(upsert[0].params[15]).toBe('2020') // created_at
    })

    it('rejects bad identifiers, cron and source', async () => {
        const { plugin } = makePlugin()
        const bad = [
            { ...VALID_BODY, table_name: 'users; DROP TABLE x' },
            { ...VALID_BODY, tracking_col: 'a b' },
            { ...VALID_BODY, cron_tab: 'definitely-not-cron' },
            {
                ...VALID_BODY,
                source: { ...VALID_BODY.source, dialect: 'sqlite' },
            },
            { ...VALID_BODY, name: 'bad name!' },
        ]
        for (const body of bad) {
            const res = await plugin['handleCreateJob'](makeContext({ body }))
            expect(res.status).toBe(400)
        }
    })

    it('rejects an explicit columns list missing tracking/primary-key columns', async () => {
        const { plugin } = makePlugin()
        const missingTracking = { ...VALID_BODY, columns: ['name', 'email'] }
        const missingPk = {
            ...VALID_BODY,
            columns: ['updated_at', 'name'],
            primary_key: ['id'],
        }
        expect(
            (
                await plugin['handleCreateJob'](
                    makeContext({ body: missingTracking })
                )
            ).status
        ).toBe(400)
        expect(
            (await plugin['handleCreateJob'](makeContext({ body: missingPk })))
                .status
        ).toBe(400)
    })

    it('accepts a columns list that includes tracking and primary key', async () => {
        const { plugin } = makePlugin()
        const res = await plugin['handleCreateJob'](
            makeContext({
                body: {
                    ...VALID_BODY,
                    columns: ['id', 'updated_at'],
                    primary_key: ['id'],
                },
            })
        )
        expect(res.status).toBe(200)
    })
})

describe('ReplicationPlugin - list/delete/reset/patch', () => {
    it('redacts the source password when listing', async () => {
        const { plugin, ds } = makePlugin()
        ds.rpc.executeQuery.mockResolvedValue([
            jobRow({
                source_config: JSON.stringify({
                    dialect: 'postgresql',
                    host: 'h',
                    password: 'secret',
                }),
            }),
        ])

        const res = await plugin['handleListJobs'](makeContext({}))
        const json: any = await res.json()
        expect(JSON.parse(json.result[0].source_config).password).toBe('***')
    })

    it('deletes the row and removes the cron task', async () => {
        const { plugin, ds } = makePlugin()
        await plugin['handleDeleteJob'](
            makeContext({ param: { name: 'users_sync' } })
        )
        expect(ds.rpc.executeQuery).toHaveBeenCalledWith(
            expect.objectContaining({
                sql: expect.stringContaining(
                    'DELETE FROM tmp_replication_jobs'
                ),
            })
        )
        expect(mockCron.removeEvent).toHaveBeenCalledWith(
            'replication:users_sync',
            ds
        )
    })

    it('resets the cursor', async () => {
        const { plugin, ds } = makePlugin()
        await plugin['handleResetJob'](
            makeContext({ param: { name: 'users_sync' } })
        )
        expect(ds.rpc.executeQuery).toHaveBeenCalledWith(
            expect.objectContaining({
                sql: expect.stringContaining('last_value = NULL'),
            })
        )
    })

    it('toggles is_active and rejects a non-boolean', async () => {
        const { plugin, ds } = makePlugin()
        await plugin['handlePatchJob'](
            makeContext({
                body: { is_active: false },
                param: { name: 'users_sync' },
            })
        )
        const call = ds.rpc.executeQuery.mock.calls.find((c: any) =>
            c[0].sql.includes('SET is_active')
        )
        expect(call[0].params).toEqual([0, 'users_sync'])

        const res = await plugin['handlePatchJob'](
            makeContext({ body: {}, param: { name: 'users_sync' } })
        )
        expect(res.status).toBe(400)
    })
})

// ── Sync engine ──────────────────────────────────────────────────────────────

describe('ReplicationPlugin - runSync', () => {
    it('first run issues a WHERE-less hardened raw pull', async () => {
        const { plugin, ds } = makePlugin()
        withJob(ds, jobRow())
        mockExecuteQuery.mockResolvedValueOnce({
            columns: ['id', 'updated_at'],
            rows: [[1, '2024-01-01']],
        } as any)

        await plugin.runSync('users_sync', ds)

        const pull = mockExecuteQuery.mock.calls[0][0]
        expect(pull.sql).not.toContain('WHERE')
        expect(pull.params).toEqual([])
        expect(pull.isRaw).toBe(true)
        expect(pull.config.role).toBe('admin')
        expect(pull.config.features?.rls).toBe(false)
        expect(pull.config.features?.allowlist).toBe(false)
        expect(pull.dataSource.source).toBe('external')
    })

    it('uses the cursor predicate with a ? parameter on subsequent runs', async () => {
        const { plugin, ds } = makePlugin()
        withJob(ds, jobRow({ last_value: '2024-01-01' }))
        mockExecuteQuery.mockResolvedValueOnce({ columns: [], rows: [] } as any)

        await plugin.runSync('users_sync', ds)

        const pull = mockExecuteQuery.mock.calls[0][0]
        expect(pull.sql).toContain('WHERE "updated_at" > ?')
        expect(pull.params).toEqual(['2024-01-01'])
    })

    it('upserts rows and advances the cursor to the max value', async () => {
        const { plugin, ds } = makePlugin()
        withJob(ds, jobRow())
        mockExecuteQuery.mockResolvedValueOnce({
            columns: ['id', 'updated_at'],
            rows: [
                [1, '2024-01-01'],
                [2, '2024-01-03'],
            ],
        } as any)

        await plugin.runSync('users_sync', ds)

        const insert = ds.rpc.executeQuery.mock.calls.find((c: any) =>
            c[0].sql.includes('INSERT OR REPLACE INTO "users"')
        )
        expect(insert).toBeTruthy()
        const cursor = ds.rpc.executeQuery.mock.calls.find((c: any) =>
            c[0].sql.includes('last_value = ?')
        )
        expect(cursor[0].params[0]).toBe('2024-01-03')
    })

    it('creates the destination table with inferred types and a primary key', async () => {
        const { plugin, ds } = makePlugin()
        withJob(ds, jobRow({ primary_key: JSON.stringify(['id']) }))
        mockExecuteQuery.mockResolvedValueOnce({
            columns: ['id', 'name', 'active', 'score'],
            rows: [[1, 'a', true, 1.5]],
        } as any)

        await plugin.runSync('users_sync', ds)

        const create = ds.rpc.executeQuery.mock.calls.find((c: any) =>
            c[0].sql.startsWith('CREATE TABLE IF NOT EXISTS "users"')
        )
        expect(create[0].sql).toContain('"id" INTEGER')
        expect(create[0].sql).toContain('"name" TEXT')
        expect(create[0].sql).toContain('"active" INTEGER')
        expect(create[0].sql).toContain('"score" REAL')
        expect(create[0].sql).toContain('PRIMARY KEY ("id")')
    })

    it('replicates into target_table when provided', async () => {
        const { plugin, ds } = makePlugin()
        withJob(ds, jobRow({ target_table: 'mirror_users' }))
        mockExecuteQuery.mockResolvedValueOnce({
            columns: ['id'],
            rows: [[1]],
        } as any)

        await plugin.runSync('users_sync', ds)
        const insert = ds.rpc.executeQuery.mock.calls.find((c: any) =>
            c[0].sql.includes('INSERT OR REPLACE INTO "mirror_users"')
        )
        expect(insert).toBeTruthy()
    })

    it('paginates until a short page and stops', async () => {
        const { plugin, ds } = makePlugin()
        withJob(ds, jobRow({ batch_size: 2 }))
        mockExecuteQuery
            .mockResolvedValueOnce({
                columns: ['id', 'updated_at'],
                rows: [
                    [1, 'a'],
                    [2, 'b'],
                ],
            } as any)
            .mockResolvedValueOnce({
                columns: ['id', 'updated_at'],
                rows: [[3, 'c']],
            } as any)

        const result = await plugin.runSync('users_sync', ds)
        expect(mockExecuteQuery).toHaveBeenCalledTimes(2)
        expect(result.pages).toBe(2)
        expect(result.rowsSynced).toBe(3)
    })

    it('is bounded by maxPagesPerRun when pages stay full', async () => {
        const { plugin, ds } = makePlugin(2)
        withJob(ds, jobRow({ batch_size: 2 }))
        mockExecuteQuery.mockResolvedValue({
            columns: ['id', 'updated_at'],
            rows: [
                [1, 'a'],
                [2, 'b'],
            ],
        } as any)

        await plugin.runSync('users_sync', ds)
        expect(mockExecuteQuery).toHaveBeenCalledTimes(2)
    })

    it('persists the cursor after each page', async () => {
        const { plugin, ds } = makePlugin()
        withJob(ds, jobRow({ batch_size: 1 }))
        mockExecuteQuery
            .mockResolvedValueOnce({
                columns: ['id', 'updated_at'],
                rows: [[1, '2024-01-01']],
            } as any)
            .mockResolvedValueOnce({
                columns: ['id', 'updated_at'],
                rows: [[2, '2024-01-02']],
            } as any)
            .mockResolvedValueOnce({
                columns: ['id', 'updated_at'],
                rows: [],
            } as any)

        await plugin.runSync('users_sync', ds)
        const cursorUpdates = ds.rpc.executeQuery.mock.calls.filter((c: any) =>
            c[0].sql.includes('last_value = ?')
        )
        expect(cursorUpdates.length).toBe(2)
    })

    it('does nothing for a paused job', async () => {
        const { plugin, ds } = makePlugin()
        withJob(ds, jobRow({ is_active: 0 }))
        const result = await plugin.runSync('users_sync', ds)
        expect(mockExecuteQuery).not.toHaveBeenCalled()
        expect(result).toEqual({ rowsSynced: 0, pages: 0 })
    })

    it('returns a no-op for an unknown job', async () => {
        const { plugin, ds } = makePlugin()
        ds.rpc.executeQuery.mockResolvedValue([])
        const result = await plugin.runSync('missing', ds)
        expect(result).toEqual({ rowsSynced: 0, pages: 0 })
    })

    it('records the error and re-throws on pull failure', async () => {
        const { plugin, ds } = makePlugin()
        withJob(ds, jobRow())
        mockExecuteQuery.mockRejectedValueOnce(new Error('source down'))

        await expect(plugin.runSync('users_sync', ds)).rejects.toThrow(
            'source down'
        )
        const meta = ds.rpc.executeQuery.mock.calls.find((c: any) =>
            c[0].sql.includes('last_run_at = ?')
        )
        expect(meta[0].params[1]).toContain('source down')
    })

    it('stops after one page when the tracking column cannot advance', async () => {
        const { plugin, ds } = makePlugin()
        withJob(ds, jobRow({ batch_size: 2 }))
        // A full page whose tracking values are all NULL: the cursor cannot
        // move forward, so we must not re-fetch the same page.
        mockExecuteQuery.mockResolvedValue({
            columns: ['id', 'updated_at'],
            rows: [
                [1, null],
                [2, null],
            ],
        } as any)

        await plugin.runSync('users_sync', ds)
        expect(mockExecuteQuery).toHaveBeenCalledTimes(1)
    })

    it('infers column types from the first non-null value across the page', async () => {
        const { plugin, ds } = makePlugin()
        withJob(ds, jobRow())
        mockExecuteQuery.mockResolvedValueOnce({
            columns: ['id', 'score', 'updated_at'],
            rows: [
                [null, null, '2024-01-01'],
                [2, 1.5, '2024-01-02'],
            ],
        } as any)

        await plugin.runSync('users_sync', ds)
        const create = ds.rpc.executeQuery.mock.calls.find((c: any) =>
            c[0].sql.startsWith('CREATE TABLE IF NOT EXISTS "users"')
        )
        expect(create[0].sql).toContain('"id" INTEGER')
        expect(create[0].sql).toContain('"score" REAL')
    })

    it('redacts the source password from sync error messages', async () => {
        const { plugin, ds } = makePlugin()
        withJob(
            ds,
            jobRow({
                source_config: JSON.stringify({
                    dialect: 'postgresql',
                    host: 'h',
                    port: 5432,
                    user: 'u',
                    password: 's3cr3t',
                    database: 'd',
                }),
            })
        )
        mockExecuteQuery.mockRejectedValueOnce(
            new Error('auth failed: password=s3cr3t')
        )

        await expect(plugin.runSync('users_sync', ds)).rejects.toThrow('***')
        const meta = ds.rpc.executeQuery.mock.calls.find((c: any) =>
            c[0].sql.includes('last_run_at = ?')
        )
        expect(meta[0].params[1]).not.toContain('s3cr3t')
        expect(meta[0].params[1]).toContain('***')
    })
})

describe('ReplicationPlugin - handleCronEvent', () => {
    it('ignores events that are not replication tasks', async () => {
        const { plugin, ds } = makePlugin()
        await plugin.handleCronEvent({ name: 'some-other-task' }, ds)
        expect(ds.rpc.executeQuery).not.toHaveBeenCalled()
        expect(mockExecuteQuery).not.toHaveBeenCalled()
    })

    it('routes a replication task to runSync by its name prefix', async () => {
        const { plugin, ds } = makePlugin()
        withJob(ds, jobRow())
        mockExecuteQuery.mockResolvedValueOnce({ columns: [], rows: [] } as any)

        await plugin.handleCronEvent({ name: 'replication:users_sync' }, ds)
        expect(ds.rpc.executeQuery).toHaveBeenCalledWith(
            expect.objectContaining({
                sql: expect.stringContaining(
                    'SELECT * FROM tmp_replication_jobs'
                ),
            })
        )
    })

    it('swallows sync errors so other jobs are unaffected', async () => {
        const { plugin, ds } = makePlugin()
        withJob(ds, jobRow())
        mockExecuteQuery.mockRejectedValueOnce(new Error('boom'))

        await expect(
            plugin.handleCronEvent({ name: 'replication:users_sync' }, ds)
        ).resolves.toBeUndefined()
    })
})

describe('ReplicationPlugin - handleRunJob', () => {
    it('runs a sync inline and returns counts', async () => {
        const { plugin, ds } = makePlugin()
        withJob(ds, jobRow())
        mockExecuteQuery.mockResolvedValueOnce({
            columns: ['id', 'updated_at'],
            rows: [[1, '2024-01-01']],
        } as any)

        const res = await plugin['handleRunJob'](
            makeContext({ param: { name: 'users_sync' } })
        )
        const json: any = await res.json()
        expect(res.status).toBe(200)
        expect(json.result.success).toBe(true)
        expect(json.result.rowsSynced).toBe(1)
    })

    it('returns 500 with the message when a sync fails', async () => {
        const { plugin, ds } = makePlugin()
        withJob(ds, jobRow())
        mockExecuteQuery.mockRejectedValueOnce(new Error('kaboom'))

        const res = await plugin['handleRunJob'](
            makeContext({ param: { name: 'users_sync' } })
        )
        expect(res.status).toBe(500)
        const json: any = await res.json()
        expect(json.error).toContain('kaboom')
    })
})
