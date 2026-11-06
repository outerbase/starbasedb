import { StarbaseApp, StarbaseDBConfiguration } from '../../src/handler'
import { executeExternalQuery } from '../../src/operation'
import { StarbasePlugin } from '../../src/plugin'
import { DataSource, QueryResult } from '../../src/types'
import { createResponse } from '../../src/utils'

export interface ReplicationTableConfig {
    table: string
    schema?: string
    cursorColumn?: string
    primaryKey?: string
    intervalSeconds?: number
    batchSize?: number
    columns?: string[]
}

export interface ReplicationPluginOptions {
    tables: (string | ReplicationTableConfig)[]
    intervalSeconds?: number
    batchSize?: number
    autoSyncOnQuery?: boolean
    ctx?: ExecutionContext
}

export interface ReplicationStatus {
    table_name: string
    cursor_column: string | null
    last_cursor_value: string | null
    last_synced_at: number
    rows_synced: number
}

const SQL_QUERIES = {
    CREATE_STATE_TABLE: `
        CREATE TABLE IF NOT EXISTS tmp_replication_state (
            table_name TEXT NOT NULL UNIQUE PRIMARY KEY,
            cursor_column TEXT,
            last_cursor_value TEXT,
            last_synced_at INTEGER NOT NULL,
            rows_synced INTEGER DEFAULT 0
        )
    `,
    GET_STATE: `
        SELECT table_name, cursor_column, last_cursor_value, last_synced_at, rows_synced
        FROM tmp_replication_state
        WHERE table_name = ?
    `,
    GET_ALL_STATES: `
        SELECT table_name, cursor_column, last_cursor_value, last_synced_at, rows_synced
        FROM tmp_replication_state
    `,
    UPSERT_STATE: `
        INSERT OR REPLACE INTO tmp_replication_state (
            table_name,
            cursor_column,
            last_cursor_value,
            last_synced_at,
            rows_synced
        ) VALUES (?, ?, ?, ?, ?)
    `,
}

function sanitizeIdentifier(identifier: string): string {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) {
        throw new Error(`Invalid SQL identifier: ${identifier}`)
    }
    return identifier
}

function inferSqliteColumnType(value: unknown): string {
    if (typeof value === 'number') {
        return Number.isInteger(value) ? 'INTEGER' : 'REAL'
    }
    if (typeof value === 'boolean') {
        return 'INTEGER'
    }
    return 'TEXT'
}

export class ReplicationPlugin extends StarbasePlugin {
    public override pathPrefix: string = '/replication'
    public tables: ReplicationTableConfig[]
    public intervalSeconds: number
    public batchSize: number
    public autoSyncOnQuery: boolean

    private dataSource?: DataSource
    private config?: StarbaseDBConfiguration
    private executionContext?: ExecutionContext
    private initialized: boolean = false

    constructor(opts: ReplicationPluginOptions) {
        super('starbasedb:replication', { requiresAuth: true }, '/replication')
        this.intervalSeconds = opts.intervalSeconds ?? 300
        this.batchSize = opts.batchSize ?? 500
        this.autoSyncOnQuery = opts.autoSyncOnQuery ?? false
        this.executionContext = opts.ctx
        this.tables = (opts.tables || []).map((t) =>
            typeof t === 'string'
                ? {
                      table: t,
                      intervalSeconds: this.intervalSeconds,
                      batchSize: this.batchSize,
                  }
                : {
                      ...t,
                      intervalSeconds:
                          t.intervalSeconds ?? this.intervalSeconds,
                      batchSize: t.batchSize ?? this.batchSize,
                  }
        )
    }

    override async register(app: StarbaseApp): Promise<void> {
        app.use('*', async (c, next) => {
            this.dataSource = c?.get('dataSource')
            this.config = c?.get('config')
            await this.init()
            await next()
        })

        app.get(`${this.pathPrefix}/status`, async () => {
            try {
                const status = await this.getStatus()
                return createResponse({ tables: status }, undefined, 200)
            } catch (error: any) {
                return createResponse(
                    undefined,
                    error?.message || 'Failed to fetch replication status',
                    500
                )
            }
        })

        app.post(`${this.pathPrefix}/sync`, async (c) => {
            if (this.config && this.config.role !== 'admin') {
                return createResponse(undefined, 'Unauthorized request', 401)
            }

            try {
                let targetTable: string | undefined
                try {
                    const body = await c.req.json()
                    targetTable = body?.table
                } catch {
                    targetTable = undefined
                }

                if (targetTable) {
                    const tableCfg = this.tables.find(
                        (t) => t.table === targetTable
                    )
                    if (!tableCfg) {
                        return createResponse(
                            undefined,
                            `Table ${targetTable} is not configured for replication`,
                            400
                        )
                    }
                    const result = await this.syncTable(tableCfg, true)
                    return createResponse(result, undefined, 200)
                }

                const results = await this.syncAll(true)
                return createResponse({ results }, undefined, 200)
            } catch (error: any) {
                return createResponse(
                    undefined,
                    error?.message || 'Replication sync failed',
                    500
                )
            }
        })
    }

    private async init(): Promise<void> {
        if (this.initialized || !this.dataSource) return

        await this.dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.CREATE_STATE_TABLE,
            params: [],
        })
        this.initialized = true
    }

    override async beforeQuery(opts: {
        sql: string
        params?: unknown[]
        dataSource?: DataSource
        config?: StarbaseDBConfiguration
    }): Promise<{ sql: string; params?: unknown[] }> {
        if (opts.dataSource) {
            this.dataSource = opts.dataSource
        }
        if (opts.config) {
            this.config = opts.config
        }

        if (this.autoSyncOnQuery && this.dataSource) {
            await this.init()
            const syncPromise = this.syncAll(false)
            const ctx =
                this.executionContext ?? this.dataSource.executionContext
            if (ctx) {
                ctx.waitUntil(syncPromise)
            } else {
                await syncPromise
            }
        }

        return {
            sql: opts.sql,
            params: opts.params,
        }
    }

    public async getStatus(): Promise<ReplicationStatus[]> {
        if (!this.dataSource) return []
        await this.init()

        const rows = (await this.dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.GET_ALL_STATES,
            params: [],
        })) as QueryResult[]

        return (rows || []).map((row) => ({
            table_name: String(row.table_name),
            cursor_column:
                row.cursor_column !== null && row.cursor_column !== undefined
                    ? String(row.cursor_column)
                    : null,
            last_cursor_value:
                row.last_cursor_value !== null &&
                row.last_cursor_value !== undefined
                    ? String(row.last_cursor_value)
                    : null,
            last_synced_at: Number(row.last_synced_at ?? 0),
            rows_synced: Number(row.rows_synced ?? 0),
        }))
    }

    public async syncAll(force: boolean = false): Promise<
        {
            table: string
            syncedRows: number
            lastCursorValue: string | null
            skipped: boolean
        }[]
    > {
        const results = []
        for (const tableCfg of this.tables) {
            const res = await this.syncTable(tableCfg, force)
            results.push(res)
        }
        return results
    }

    public async syncTable(
        tableCfg: ReplicationTableConfig,
        force: boolean = false
    ): Promise<{
        table: string
        syncedRows: number
        lastCursorValue: string | null
        skipped: boolean
    }> {
        if (!this.dataSource || !this.config) {
            throw new Error('ReplicationPlugin is not initialized with a dataSource')
        }

        await this.init()

        const tableName = sanitizeIdentifier(tableCfg.table)
        const schemaName = tableCfg.schema
            ? sanitizeIdentifier(tableCfg.schema)
            : undefined
        const cursorCol = tableCfg.cursorColumn
            ? sanitizeIdentifier(tableCfg.cursorColumn)
            : undefined
        const pkCol = tableCfg.primaryKey
            ? sanitizeIdentifier(tableCfg.primaryKey)
            : cursorCol

        const stateRows = (await this.dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.GET_STATE,
            params: [tableName],
        })) as QueryResult[]

        const currentState = stateRows?.[0]
        const now = Date.now()
        const intervalMs =
            (tableCfg.intervalSeconds ?? this.intervalSeconds) * 1000

        if (
            !force &&
            currentState &&
            now - Number(currentState.last_synced_at ?? 0) < intervalMs
        ) {
            return {
                table: tableName,
                syncedRows: 0,
                lastCursorValue:
                    currentState.last_cursor_value !== null &&
                    currentState.last_cursor_value !== undefined
                        ? String(currentState.last_cursor_value)
                        : null,
                skipped: true,
            }
        }

        const lastCursorValue =
            currentState?.last_cursor_value !== null &&
            currentState?.last_cursor_value !== undefined
                ? String(currentState.last_cursor_value)
                : null

        const selectCols =
            tableCfg.columns && tableCfg.columns.length > 0
                ? tableCfg.columns.map(sanitizeIdentifier).join(', ')
                : '*'
        const qualifiedTable = schemaName
            ? `${schemaName}.${tableName}`
            : tableName
        const limit = tableCfg.batchSize ?? this.batchSize

        let externalSql = `SELECT ${selectCols} FROM ${qualifiedTable}`
        const externalParams: unknown[] = []

        if (cursorCol && lastCursorValue !== null) {
            externalSql += ` WHERE ${cursorCol} > ?`
            externalParams.push(lastCursorValue)
        }

        if (cursorCol) {
            externalSql += ` ORDER BY ${cursorCol} ASC`
        }

        externalSql += ` LIMIT ${Number(limit)}`

        const externalRows = (await executeExternalQuery({
            sql: externalSql,
            params: externalParams,
            dataSource: this.dataSource,
            config: this.config,
        })) as Record<string, unknown>[]

        if (!Array.isArray(externalRows) || externalRows.length === 0) {
            const prevSynced = Number(currentState?.rows_synced ?? 0)
            await this.dataSource.rpc.executeQuery({
                sql: SQL_QUERIES.UPSERT_STATE,
                params: [
                    tableName,
                    cursorCol ?? null,
                    lastCursorValue,
                    now,
                    prevSynced,
                ],
            })
            return {
                table: tableName,
                syncedRows: 0,
                lastCursorValue,
                skipped: false,
            }
        }

        const firstRow = externalRows[0]
        const columns = Object.keys(firstRow).map(sanitizeIdentifier)

        const colDefs = columns.map((col) => {
            const colType = inferSqliteColumnType(firstRow[col])
            const pkSuffix = pkCol && col === pkCol ? ' PRIMARY KEY' : ''
            return `"${col}" ${colType}${pkSuffix}`
        })

        await this.dataSource.rpc.executeQuery({
            sql: `CREATE TABLE IF NOT EXISTS "${tableName}" (${colDefs.join(', ')})`,
            params: [],
        })

        const placeholders = columns.map(() => '?').join(', ')
        const quotedCols = columns.map((c) => `"${c}"`).join(', ')
        const insertSql = `INSERT OR REPLACE INTO "${tableName}" (${quotedCols}) VALUES (${placeholders})`

        let newCursorValue = lastCursorValue
        for (const row of externalRows) {
            const values = columns.map((col) => {
                const v = row[col]
                if (typeof v === 'boolean') return v ? 1 : 0
                if (v !== null && typeof v === 'object') return JSON.stringify(v)
                return v ?? null
            })
            await this.dataSource.rpc.executeQuery({
                sql: insertSql,
                params: values,
            })

            if (cursorCol && row[cursorCol] !== undefined && row[cursorCol] !== null) {
                newCursorValue = String(row[cursorCol])
            }
        }

        const totalSynced =
            Number(currentState?.rows_synced ?? 0) + externalRows.length

        await this.dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.UPSERT_STATE,
            params: [
                tableName,
                cursorCol ?? null,
                newCursorValue,
                now,
                totalSynced,
            ],
        })

        return {
            table: tableName,
            syncedRows: externalRows.length,
            lastCursorValue: newCursorValue,
            skipped: false,
        }
    }
}
