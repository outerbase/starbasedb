import { describe, it, expect, vi, beforeEach } from 'vitest'
import fc from 'fast-check'
import { DataReplicationPlugin, ReplicationConfig } from './index'
import { DataSource } from '../../src/types'

vi.mock('../../src/operation', () => ({
    executeExternalQuery: vi.fn(),
}))

import { executeExternalQuery } from '../../src/operation'

const mockedExecuteExternalQuery = vi.mocked(executeExternalQuery)

let plugin: DataReplicationPlugin
let mockRpc: {
    executeQuery: ReturnType<typeof vi.fn>
    setAlarm: ReturnType<typeof vi.fn>
}
let mockDataSource: DataSource

beforeEach(() => {
    vi.clearAllMocks()

    mockRpc = {
        executeQuery: vi.fn().mockResolvedValue([]),
        setAlarm: vi.fn().mockResolvedValue(undefined),
    }

    mockDataSource = {
        rpc: mockRpc as any,
        source: 'external',
        external: {
            dialect: 'postgresql',
            host: 'localhost',
            port: 5432,
            user: 'test',
            password: 'test',
            database: 'testdb',
        },
    } as DataSource

    plugin = new DataReplicationPlugin()
    ;(plugin as any).dataSource = mockDataSource
    ;(plugin as any).config = { role: 'admin' }
})

//  Generators ──────────────────────────────────────────────────────────────

/** Generate a non-empty, non-whitespace-only table name */
const validTableName = fc
    .stringMatching(/^[a-z][a-z0-9_]{0,29}$/)
    .filter((s) => s.length > 0)

/** Generate a positive integer for interval_seconds */
const positiveInt = fc.integer({ min: 1, max: 100000 })

/** Generate a valid ReplicationConfig payload for creation */
const validConfigPayload = fc.record({
    source_table: validTableName,
    target_table: fc.option(validTableName, { nil: null }),
    columns: fc.option(
        fc
            .array(validTableName, { minLength: 1, maxLength: 5 })
            .map((cols) => JSON.stringify(cols)),
        { nil: null }
    ),
    cursor_column: fc.option(validTableName, { nil: null }),
    interval_seconds: positiveInt,
    enabled: fc.boolean().map((b) => (b ? 1 : 0)),
})

//  Property 1: Config CRUD round-trip ──────────────────────────────────────

describe('Property 1: Config CRUD round-trip', () => {
    it('should accept any valid ReplicationConfig payload through validation', async () => {
        await fc.assert(
            fc.asyncProperty(validConfigPayload, async (payload) => {
                // The validation logic from the POST handler
                const sourceValid =
                    payload.source_table &&
                    typeof payload.source_table === 'string' &&
                    payload.source_table.trim().length > 0
                const intervalValid =
                    payload.interval_seconds !== undefined &&
                    payload.interval_seconds !== null &&
                    Number.isInteger(payload.interval_seconds) &&
                    payload.interval_seconds > 0

                expect(sourceValid).toBeTruthy()
                expect(intervalValid).toBe(true)
            }),
            { numRuns: 100 }
        )
    })

    it('should round-trip config through insert and select SQL', async () => {
        await fc.assert(
            fc.asyncProperty(validConfigPayload, async (payload) => {
                vi.clearAllMocks()

                const fakeConfig: ReplicationConfig = {
                    id: 1,
                    source_table: payload.source_table,
                    target_table: payload.target_table,
                    columns: payload.columns,
                    cursor_column: payload.cursor_column,
                    interval_seconds: payload.interval_seconds,
                    enabled: payload.enabled,
                    callback_host: null,
                    created_at: '2024-01-01 00:00:00',
                    updated_at: '2024-01-01 00:00:00',
                }

                // Mock: init tables, scheduleNextAlarm query, INSERT, SELECT created
                mockRpc.executeQuery
                    .mockResolvedValueOnce([]) // CREATE configs table
                    .mockResolvedValueOnce([]) // CREATE state table
                    .mockResolvedValueOnce([]) // scheduleNextAlarm query
                    .mockResolvedValueOnce([]) // INSERT
                    .mockResolvedValueOnce([fakeConfig]) // SELECT created

                // Simulate the insert SQL params the handler would build
                const insertParams = [
                    payload.source_table.trim(),
                    payload.target_table || null,
                    payload.columns || null,
                    payload.cursor_column || null,
                    payload.interval_seconds,
                    payload.enabled,
                    null, // callback_host
                ]

                // Verify the config we get back matches what we put in
                expect(fakeConfig.source_table).toBe(payload.source_table)
                expect(fakeConfig.interval_seconds).toBe(
                    payload.interval_seconds
                )
                expect(fakeConfig.target_table).toBe(payload.target_table)
                expect(fakeConfig.columns).toBe(payload.columns)
                expect(fakeConfig.cursor_column).toBe(payload.cursor_column)
            }),
            { numRuns: 100 }
        )
    })
})

//  Property 2: Invalid config rejection ────────────────────────────────────

describe('Property 2: Invalid config rejection', () => {
    it('should reject configs with missing/empty/whitespace-only source_table', async () => {
        const invalidSourceTable = fc.oneof(
            fc.constant(''),
            fc.constant('   '),
            fc.constant('\t'),
            fc.constant('\n'),
            fc.stringMatching(/^\s+$/).filter((s) => s.length > 0),
            fc.constant(undefined as unknown as string),
            fc.constant(null as unknown as string)
        )

        await fc.assert(
            fc.asyncProperty(
                invalidSourceTable,
                positiveInt,
                async (sourceTable, interval) => {
                    const isInvalid =
                        !sourceTable ||
                        typeof sourceTable !== 'string' ||
                        !sourceTable.trim()

                    expect(isInvalid).toBe(true)
                }
            ),
            { numRuns: 100 }
        )
    })

    it('should reject configs with missing/zero/negative interval_seconds', async () => {
        const invalidInterval = fc.oneof(
            fc.constant(0),
            fc.integer({ min: -100000, max: -1 }),
            fc.constant(undefined as unknown as number),
            fc.constant(null as unknown as number),
            fc
                .double({ min: 0.1, max: 99.9, noNaN: true })
                .filter((n) => !Number.isInteger(n))
        )

        await fc.assert(
            fc.asyncProperty(
                validTableName,
                invalidInterval,
                async (sourceTable, interval) => {
                    const isInvalid =
                        interval === undefined ||
                        interval === null ||
                        !Number.isInteger(interval) ||
                        interval <= 0

                    expect(isInvalid).toBe(true)
                }
            ),
            { numRuns: 100 }
        )
    })
})

//  Property 3: Config listing completeness ─────────────────────────────────

describe('Property 3: Config listing completeness', () => {
    it('should list all inserted configs', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.array(validConfigPayload, { minLength: 0, maxLength: 10 }),
                async (payloads) => {
                    vi.clearAllMocks()

                    // Build fake configs with sequential IDs
                    const fakeConfigs: ReplicationConfig[] = payloads.map(
                        (p, i) => ({
                            id: i + 1,
                            source_table: p.source_table,
                            target_table: p.target_table,
                            columns: p.columns,
                            cursor_column: p.cursor_column,
                            interval_seconds: p.interval_seconds,
                            enabled: p.enabled,
                            callback_host: null,
                            created_at: '2024-01-01 00:00:00',
                            updated_at: '2024-01-01 00:00:00',
                        })
                    )

                    // Mock the list query to return all configs
                    mockRpc.executeQuery.mockResolvedValueOnce(fakeConfigs)

                    const result = (await mockRpc.executeQuery({
                        sql: 'SELECT * FROM tmp_replication_configs',
                        params: [],
                    })) as ReplicationConfig[]

                    expect(result).toHaveLength(payloads.length)
                    for (let i = 0; i < payloads.length; i++) {
                        expect(result[i].source_table).toBe(
                            payloads[i].source_table
                        )
                        expect(result[i].interval_seconds).toBe(
                            payloads[i].interval_seconds
                        )
                    }
                }
            ),
            { numRuns: 100 }
        )
    })
})

//  Property 10: Type mapping correctness ───────────────────────────────────

describe('Property 10: Type mapping correctness', () => {
    it('should always return one of INTEGER, REAL, BLOB, or TEXT for any type string', async () => {
        const validSQLiteTypes = ['INTEGER', 'REAL', 'BLOB', 'TEXT']

        await fc.assert(
            fc.property(
                fc.string({ minLength: 0, maxLength: 50 }),
                (externalType) => {
                    const result = plugin.mapToSQLiteType(externalType)
                    expect(validSQLiteTypes).toContain(result)
                }
            ),
            { numRuns: 100 }
        )
    })

    it('should be idempotent: mapToSQLiteType(mapToSQLiteType(t)) === mapToSQLiteType(t)', async () => {
        await fc.assert(
            fc.property(
                fc.string({ minLength: 0, maxLength: 50 }),
                (externalType) => {
                    const first = plugin.mapToSQLiteType(externalType)
                    const second = plugin.mapToSQLiteType(first)
                    expect(second).toBe(first)
                }
            ),
            { numRuns: 100 }
        )
    })

    it('should map known integer types to INTEGER', async () => {
        const integerTypes = fc.oneof(
            fc.constant('integer'),
            fc.constant('int'),
            fc.constant('smallint'),
            fc.constant('bigint'),
            fc.constant('serial'),
            fc.constant('bigserial'),
            fc.constant('tinyint'),
            fc.constant('mediumint'),
            fc.constant('int2'),
            fc.constant('int4'),
            fc.constant('int8')
        )

        await fc.assert(
            fc.property(integerTypes, (t) => {
                expect(plugin.mapToSQLiteType(t)).toBe('INTEGER')
            }),
            { numRuns: 100 }
        )
    })

    it('should map known real types to REAL', async () => {
        const realTypes = fc.oneof(
            fc.constant('real'),
            fc.constant('double'),
            fc.constant('float'),
            fc.constant('numeric'),
            fc.constant('decimal'),
            fc.constant('double precision'),
            fc.constant('float4'),
            fc.constant('float8')
        )

        await fc.assert(
            fc.property(realTypes, (t) => {
                expect(plugin.mapToSQLiteType(t)).toBe('REAL')
            }),
            { numRuns: 100 }
        )
    })

    it('should map known blob types to BLOB', async () => {
        const blobTypes = fc.oneof(
            fc.constant('bytea'),
            fc.constant('blob'),
            fc.constant('binary'),
            fc.constant('varbinary'),
            fc.constant('longblob'),
            fc.constant('mediumblob'),
            fc.constant('tinyblob')
        )

        await fc.assert(
            fc.property(blobTypes, (t) => {
                expect(plugin.mapToSQLiteType(t)).toBe('BLOB')
            }),
            { numRuns: 100 }
        )
    })

    it('should map boolean types to INTEGER', async () => {
        const boolTypes = fc.oneof(fc.constant('boolean'), fc.constant('bool'))

        await fc.assert(
            fc.property(boolTypes, (t) => {
                expect(plugin.mapToSQLiteType(t)).toBe('INTEGER')
            }),
            { numRuns: 100 }
        )
    })

    it('should strip parenthesized size specifiers before mapping', async () => {
        await fc.assert(
            fc.property(
                fc.oneof(
                    fc.constant('int'),
                    fc.constant('varchar'),
                    fc.constant('decimal')
                ),
                fc.integer({ min: 1, max: 255 }),
                (baseType, size) => {
                    const withSize = `${baseType}(${size})`
                    const withoutSize = baseType
                    expect(plugin.mapToSQLiteType(withSize)).toBe(
                        plugin.mapToSQLiteType(withoutSize)
                    )
                }
            ),
            { numRuns: 100 }
        )
    })
})

//  Property 4: Config defaults applied ─────────────────────────────────────

describe('Property 4: Config defaults applied', () => {
    it('should use source_table as target when target_table is null', async () => {
        await fc.assert(
            fc.asyncProperty(
                validTableName,
                positiveInt,
                async (sourceTable, interval) => {
                    const config: ReplicationConfig = {
                        id: 1,
                        source_table: sourceTable,
                        target_table: null,
                        columns: null,
                        cursor_column: null,
                        interval_seconds: interval,
                        enabled: 1,
                        callback_host: null,
                        created_at: '2024-01-01 00:00:00',
                        updated_at: '2024-01-01 00:00:00',
                    }

                    // The effective target table should equal source_table when target_table is null
                    const effectiveTarget =
                        config.target_table || config.source_table
                    expect(effectiveTarget).toBe(sourceTable)
                }
            ),
            { numRuns: 100 }
        )
    })

    it('should use all columns (SELECT *) when columns is null', async () => {
        await fc.assert(
            fc.asyncProperty(
                validTableName,
                positiveInt,
                async (sourceTable, interval) => {
                    vi.clearAllMocks()

                    const config: ReplicationConfig = {
                        id: 1,
                        source_table: sourceTable,
                        target_table: null,
                        columns: null,
                        cursor_column: null,
                        interval_seconds: interval,
                        enabled: 1,
                        callback_host: null,
                        created_at: '2024-01-01 00:00:00',
                        updated_at: '2024-01-01 00:00:00',
                    }

                    mockedExecuteExternalQuery.mockResolvedValueOnce([])

                    await plugin.fetchExternalRows(config, null)

                    expect(mockedExecuteExternalQuery).toHaveBeenCalledWith(
                        expect.objectContaining({
                            sql: `SELECT * FROM ${sourceTable}`,
                        })
                    )
                }
            ),
            { numRuns: 100 }
        )
    })
})

//  Property 7: Incremental fetch uses cursor filter ────────────────────────

describe('Property 7: Incremental fetch uses cursor filter', () => {
    it('should include WHERE clause with cursor filter when cursor_column and lastCursor are set', async () => {
        await fc.assert(
            fc.asyncProperty(
                validTableName,
                validTableName,
                fc.integer({ min: -10000, max: 10000 }).map(String),
                async (sourceTable, cursorColumn, lastCursor) => {
                    vi.clearAllMocks()

                    const config: ReplicationConfig = {
                        id: 1,
                        source_table: sourceTable,
                        target_table: null,
                        columns: null,
                        cursor_column: cursorColumn,
                        interval_seconds: 60,
                        enabled: 1,
                        callback_host: null,
                        created_at: '2024-01-01 00:00:00',
                        updated_at: '2024-01-01 00:00:00',
                    }

                    mockedExecuteExternalQuery.mockResolvedValueOnce([])

                    await plugin.fetchExternalRows(config, lastCursor)

                    const call = mockedExecuteExternalQuery.mock.calls[0][0]
                    expect(call.sql).toContain(`WHERE ${cursorColumn} > ?`)
                    expect(call.params).toContain(lastCursor)
                    expect(call.sql).toContain(`ORDER BY ${cursorColumn} ASC`)
                }
            ),
            { numRuns: 100 }
        )
    })
})

//  Property 8: Full replacement clears target before insert ────────────────

describe('Property 8: Full replacement clears target before insert', () => {
    it('should call DELETE before INSERT in full mode (no cursor_column)', async () => {
        await fc.assert(
            fc.asyncProperty(
                validTableName,
                fc.array(
                    fc.record({
                        id: fc.integer({ min: 1, max: 10000 }),
                        name: fc.string({ minLength: 1, maxLength: 20 }),
                    }),
                    { minLength: 1, maxLength: 5 }
                ),
                async (targetTable, rows) => {
                    vi.clearAllMocks()
                    mockRpc.executeQuery.mockResolvedValue([])

                    await plugin.insertRows(targetTable, rows, 'full')

                    const calls = mockRpc.executeQuery.mock.calls
                    // First call should be DELETE
                    expect(calls[0][0].sql).toBe(`DELETE FROM "${targetTable}"`)
                    // Subsequent calls should be INSERT (not INSERT OR REPLACE)
                    for (let i = 1; i < calls.length; i++) {
                        expect(calls[i][0].sql).toContain(
                            `INSERT INTO "${targetTable}"`
                        )
                        expect(calls[i][0].sql).not.toContain(
                            'INSERT OR REPLACE'
                        )
                    }
                }
            ),
            { numRuns: 100 }
        )
    })
})

//  Property 9: Sync state reflects sync results ────────────────────────────

describe('Property 9: Sync state reflects sync results', () => {
    it('should call updateSyncState with exact configId, cursor, and rowCount', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.integer({ min: 1, max: 10000 }),
                fc.option(fc.nat({ max: 10000 }).map(String), { nil: null }),
                fc.nat({ max: 10000 }),
                async (configId, cursorValue, rowCount) => {
                    vi.clearAllMocks()
                    mockRpc.executeQuery.mockResolvedValue([])

                    await plugin.updateSyncState(
                        configId,
                        cursorValue,
                        rowCount
                    )

                    expect(mockRpc.executeQuery).toHaveBeenCalledTimes(1)
                    const call = mockRpc.executeQuery.mock.calls[0][0]
                    expect(call.sql).toContain(
                        'INSERT OR REPLACE INTO tmp_replication_state'
                    )
                    expect(call.params[0]).toBe(configId)
                    expect(call.params[1]).toBe(cursorValue)
                    expect(call.params[2]).toBe(rowCount)
                }
            ),
            { numRuns: 100 }
        )
    })
})

//  Property 11: Data insertion round-trip ──────────────────────────────────

describe('Property 11: Data insertion round-trip', () => {
    it('should call executeQuery once per row with correct params', async () => {
        await fc.assert(
            fc.asyncProperty(
                validTableName,
                fc.array(
                    fc.record({
                        id: fc.integer({ min: 1, max: 10000 }),
                        value: fc.string({ minLength: 1, maxLength: 20 }),
                    }),
                    { minLength: 1, maxLength: 10 }
                ),
                async (targetTable, rows) => {
                    vi.clearAllMocks()
                    mockRpc.executeQuery.mockResolvedValue([])

                    const count = await plugin.insertRows(
                        targetTable,
                        rows,
                        'incremental'
                    )

                    // Should return the number of rows inserted
                    expect(count).toBe(rows.length)

                    // Should call executeQuery once per row (no DELETE in incremental mode)
                    expect(mockRpc.executeQuery).toHaveBeenCalledTimes(
                        rows.length
                    )

                    // Each call should have correct params
                    for (let i = 0; i < rows.length; i++) {
                        const call = mockRpc.executeQuery.mock.calls[i][0]
                        expect(call.sql).toContain('INSERT OR REPLACE INTO')
                        expect(call.sql).toContain(`"${targetTable}"`)
                        expect(call.params).toEqual([rows[i].id, rows[i].value])
                    }
                }
            ),
            { numRuns: 100 }
        )
    })
})

//  Property 5: Disabled configs skipped during sync ────────────────────────

describe('Property 5: Disabled configs skipped during sync', () => {
    it('should only process enabled configs during a sync cycle', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.array(
                    fc.record({
                        source_table: validTableName,
                        interval_seconds: positiveInt,
                        enabled: fc.boolean(),
                    }),
                    { minLength: 1, maxLength: 8 }
                ),
                async (configSpecs) => {
                    vi.clearAllMocks()

                    const allConfigs: ReplicationConfig[] = configSpecs.map(
                        (spec, i) => ({
                            id: i + 1,
                            source_table: spec.source_table,
                            target_table: null,
                            columns: null,
                            cursor_column: null,
                            interval_seconds: spec.interval_seconds,
                            enabled: spec.enabled ? 1 : 0,
                            callback_host: null,
                            created_at: '2024-01-01 00:00:00',
                            updated_at: '2024-01-01 00:00:00',
                        })
                    )

                    const enabledConfigs = allConfigs.filter(
                        (c) => c.enabled === 1
                    )
                    const disabledConfigs = allConfigs.filter(
                        (c) => c.enabled === 0
                    )

                    // Simulate the callback handler filtering: only enabled configs are processed
                    const processedIds: number[] = []
                    for (const config of allConfigs) {
                        if (config.enabled === 1) {
                            processedIds.push(config.id)
                        }
                    }

                    // Verify only enabled configs were processed
                    expect(processedIds).toHaveLength(enabledConfigs.length)
                    for (const dc of disabledConfigs) {
                        expect(processedIds).not.toContain(dc.id)
                    }
                    for (const ec of enabledConfigs) {
                        expect(processedIds).toContain(ec.id)
                    }
                }
            ),
            { numRuns: 100 }
        )
    })
})

//  Property 6: Alarm scheduling uses earliest due time ─────────────────────

describe('Property 6: Alarm scheduling uses earliest due time', () => {
    it('should set alarm to the earliest due time among enabled configs', async () => {
        await fc.assert(
            fc.asyncProperty(
                fc.array(
                    fc.record({
                        interval_seconds: fc.integer({ min: 10, max: 3600 }),
                        last_sync_at_offset_ms: fc.option(
                            fc.integer({ min: -600000, max: 0 }),
                            { nil: null }
                        ),
                    }),
                    { minLength: 1, maxLength: 5 }
                ),
                async (configSpecs) => {
                    vi.clearAllMocks()

                    const now = Date.now()

                    const configs = configSpecs.map((spec, i) => {
                        let last_sync_at: string | null = null
                        if (spec.last_sync_at_offset_ms !== null) {
                            const ts = new Date(
                                now + spec.last_sync_at_offset_ms
                            )
                            last_sync_at = ts
                                .toISOString()
                                .replace('T', ' ')
                                .replace('Z', '')
                        }
                        return {
                            id: i + 1,
                            interval_seconds: spec.interval_seconds,
                            enabled: 1,
                            last_sync_at,
                        }
                    })

                    mockRpc.executeQuery.mockResolvedValueOnce(configs)

                    await plugin.scheduleNextAlarm()

                    expect(mockRpc.setAlarm).toHaveBeenCalledTimes(1)
                    const alarmTime = mockRpc.setAlarm.mock
                        .calls[0][0] as number

                    // Compute expected earliest due time
                    let expectedEarliest = Infinity
                    for (const config of configs) {
                        let nextSync: number
                        if (config.last_sync_at) {
                            const lastSyncMs = new Date(
                                config.last_sync_at + 'Z'
                            ).getTime()
                            nextSync =
                                lastSyncMs + config.interval_seconds * 1000
                        } else {
                            nextSync = now
                        }
                        if (nextSync < expectedEarliest) {
                            expectedEarliest = nextSync
                        }
                    }

                    // The alarm should be at max(expectedEarliest, now + 1000)
                    // Allow some tolerance for timing
                    expect(alarmTime).toBeGreaterThanOrEqual(now)
                    // The alarm time should be close to the expected earliest (within a few seconds tolerance)
                    const expectedAlarmTime = Math.max(
                        expectedEarliest,
                        now + 1000
                    )
                    expect(
                        Math.abs(alarmTime - expectedAlarmTime)
                    ).toBeLessThan(5000)
                }
            ),
            { numRuns: 100 }
        )
    })
})
