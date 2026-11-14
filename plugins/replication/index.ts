import * as cronParser from 'cron-parser'
import type { StarbaseApp, StarbaseDBConfiguration } from '../../src/handler'
import { executeExternalQuery } from '../../src/operation'
import { StarbasePlugin } from '../../src/plugin'
import type { DataSource, QueryResult } from '../../src/types'
import { createResponse } from '../../src/utils'

const STATE_TABLE = '_starbase_replication_state'
const IDENTIFIER_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/

const SQL_QUERIES = {
    CREATE_STATE_TABLE: `
        CREATE TABLE IF NOT EXISTS ${STATE_TABLE} (
            table_name TEXT PRIMARY KEY NOT NULL,
            target_table TEXT NOT NULL,
            cursor_column TEXT,
            last_cursor_value TEXT,
            primary_key TEXT NOT NULL DEFAULT 'id',
            sync_mode TEXT NOT NULL DEFAULT 'incremental',
            rows_replicated INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'pending',
            last_error TEXT,
            retry_count INTEGER NOT NULL DEFAULT 0,
            last_synced_at TEXT,
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
    `,
    UPSERT_STATE: `
        INSERT INTO ${STATE_TABLE} (
            table_name, target_table, cursor_column, last_cursor_value,
            primary_key, sync_mode, rows_replicated, status, last_error,
            retry_count, last_synced_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(table_name) DO UPDATE SET
            target_table = excluded.target_table,
            cursor_column = excluded.cursor_column,
            last_cursor_value = excluded.last_cursor_value,
            primary_key = excluded.primary_key,
            sync_mode = excluded.sync_mode,
            rows_replicated = excluded.rows_replicated,
            status = excluded.status,
            last_error = excluded.last_error,
            retry_count = excluded.retry_count,
            last_synced_at = excluded.last_synced_at,
            updated_at = datetime('now')
    `,
    GET_ALL_STATES: `SELECT * FROM ${STATE_TABLE} ORDER BY table_name ASC`,
    GET_STATE: `SELECT * FROM ${STATE_TABLE} WHERE table_name = ?`,
    DELETE_STATE: `DELETE FROM ${STATE_TABLE} WHERE table_name = ?`,
}

export interface TableReplicationConfig {
    tableName: string
    targetTable?: string
    schema?: string
    cursorColumn?: string
    primaryKey?: string
    batchSize?: number
    whereClause?: string
    fullRefresh?: boolean
}

export interface ReplicationStateRow {
    table_name: string
    target_table: string
    cursor_column: string | null
    last_cursor_value: string | null
    primary_key: string
    sync_mode: 'full' | 'incremental'
    rows_replicated: number
    status: 'pending' | 'syncing' | 'idle' | 'error'
    last_error: string | null
    retry_count: number
    last_synced_at: string | null
    updated_at: string
}

export interface TableSyncResult {
    tableName: string
    targetTable: string
    rowsSynced: number
    lastCursor: string | null
    columnsAdded: string[]
    status: 'success' | 'error'
    error?: string
}

export type ExternalQueryFn = (opts: {
    sql: string
    params: unknown[]
    dataSource: DataSource
    config: StarbaseDBConfiguration
}) => Promise<any>

export interface ReplicationPluginOptions {
    tables?: TableReplicationConfig[]
    syncIntervalMs?: number
    cronTab?: string
    defaultBatchSize?: number
    maxRetries?: number
    retryDelayMs?: number
    syncOnInit?: boolean
    ctx?: ExecutionContext
    externalQueryFn?: ExternalQueryFn
}

function assertValidIdentifier(name: string, label = 'identifier'): string {
    if (!name || !IDENTIFIER_PATTERN.test(name)) {
        throw new Error(`Invalid SQL ${label}: "${name}"`)
    }
    return name
}

function quoteSqliteIdent(name: string): string {
    return `"${assertValidIdentifier(name)}"`
}

function quoteExternalTable(
    tableName: string,
    dialect: string | undefined,
    schema?: string
): string {
    const quotePart = (part: string) => {
        const clean = assertValidIdentifier(part)
        return dialect === 'mysql' ? `\`${clean}\`` : `"${clean}"`
    }

    if (schema) {
        return `${quotePart(schema)}.${quotePart(tableName)}`
    }
    return quotePart(tableName)
}

function quoteExternalCol(colName: string, dialect: string | undefined): string {
    const clean = assertValidIdentifier(colName, 'column')
    return dialect === 'mysql' ? `\`${clean}\`` : `"${clean}"`
}

function inferSqliteColumnType(values: unknown[]): 'INTEGER' | 'REAL' | 'BLOB' | 'TEXT' {
    let sawReal = false
    let sawInt = false
    let sawBlob = false
    let sawText = false

    for (const val of values) {
        if (val === null || val === undefined) continue
        if (typeof val === 'number') {
            if (Number.isInteger(val)) {
                sawInt = true
            } else {
                sawReal = true
            }
        } else if (typeof val === 'boolean') {
            sawInt = true
        } else if (val instanceof Uint8Array) {
            sawBlob = true
        } else {
            sawText = true
        }
    }

    if (sawText) return 'TEXT'
    if (sawBlob && !sawInt && !sawReal) return 'BLOB'
    if (sawReal) return 'REAL'
    if (sawInt) return 'INTEGER'
    return 'TEXT'
}

function serializeSqliteValue(val: unknown): unknown {
    if (val === undefined || val === null) return null
    if (val instanceof Date) return val.toISOString()
    if (typeof val === 'boolean') return val ? 1 : 0
    if (typeof val === 'bigint') return Number(val)
    if (val instanceof Uint8Array) return val
    if (typeof val === 'object') return JSON.stringify(val)
    return val
}

function normalizeRows(rawResult: any): Record<string, any>[] {
    if (!rawResult) return []
    if (Array.isArray(rawResult)) return rawResult
    if (Array.isArray(rawResult.rows) && Array.isArray(rawResult.columns)) {
        return rawResult.rows.map((row: unknown[]) => {
            const obj: Record<string, unknown> = {}
            rawResult.columns.forEach((col: string, idx: number) => {
                obj[col] = row[idx]
            })
            return obj
        })
    }
    if (Array.isArray(rawResult.results)) return rawResult.results
    return []
}

function placeholderFor(dialect: string | undefined, indexZeroBased: number): string {
    return dialect === 'postgresql' ? `$${indexZeroBased + 1}` : '?'
}

export class ReplicationPlugin extends StarbasePlugin {
    public pathPrefix = '/replication'
    private tables: Map<string, TableReplicationConfig> = new Map()
    private syncIntervalMs?: number
    private cronTab?: string
    private defaultBatchSize: number
    private maxRetries: number
    private retryDelayMs: number
    private syncOnInit: boolean
    private ctx?: ExecutionContext
    private externalQueryFn: ExternalQueryFn
    private dataSource?: DataSource
    private config?: StarbaseDBConfiguration
    private initialized = false
    private syncing = false

    constructor(opts: ReplicationPluginOptions = {}) {
        super('starbasedb:replication', { requiresAuth: true }, '/replication')
        for (const table of opts.tables ?? []) {
            this.validateTableConfig(table)
            this.tables.set(table.tableName, table)
        }
        this.syncIntervalMs = opts.syncIntervalMs
        this.cronTab = opts.cronTab
        this.defaultBatchSize = opts.defaultBatchSize ?? 500
        this.maxRetries = opts.maxRetries ?? 3
        this.retryDelayMs = opts.retryDelayMs ?? 100
        this.syncOnInit = opts.syncOnInit ?? false
        this.ctx = opts.ctx
        this.externalQueryFn = opts.externalQueryFn ?? executeExternalQuery
    }

    private validateTableConfig(cfg: TableReplicationConfig): void {
        assertValidIdentifier(cfg.tableName, 'tableName')
        if (cfg.targetTable) assertValidIdentifier(cfg.targetTable, 'targetTable')
        if (cfg.schema) assertValidIdentifier(cfg.schema, 'schema')
        if (cfg.cursorColumn) assertValidIdentifier(cfg.cursorColumn, 'cursorColumn')
        if (cfg.primaryKey) assertValidIdentifier(cfg.primaryKey, 'primaryKey')
    }

    public setContext(dataSource: DataSource, config?: StarbaseDBConfiguration): void {
        this.dataSource = dataSource
        this.config = config
    }

    override async register(app: StarbaseApp): Promise<void> {
        app.use(async (c, next) => {
            const ds = c?.get('dataSource')
            const cfg = c?.get('config')
            if (ds) this.dataSource = ds
            if (cfg) this.config = cfg

            if (!this.initialized && this.dataSource) {
                await this.init()
                this.initialized = true

                if (this.syncOnInit) {
                    const syncPromise = this.syncAll().catch((err) => {
                        console.error('Initial replication sync failed:', err)
                    })
                    if (this.ctx) {
                        this.ctx.waitUntil(syncPromise)
                    } else {
                        await syncPromise
                    }
                }

                await this.scheduleNextSync()
            }

            await next()
        })

        app.get(`${this.pathPrefix}/status`, async () => {
            await this.init()
            const states = await this.getStatus()
            return createResponse({ tables: states, syncing: this.syncing }, undefined, 200)
        })

        app.post(`${this.pathPrefix}/sync`, async (c) => {
            await this.init()
            let body: { table?: string; fullRefresh?: boolean } = {}
            try {
                body = (await c.req.json()) ?? {}
            } catch {
                // Empty JSON body triggers sync for all configured tables
            }

            if (body.table) {
                const result = await this.syncTable(body.table, {
                    fullRefresh: body.fullRefresh,
                })
                return createResponse({ results: [result] }, undefined, result.status === 'error' ? 500 : 200)
            }

            const results = await this.syncAll({ fullRefresh: body.fullRefresh })
            const hasErrors = results.some((r) => r.status === 'error')
            return createResponse({ results }, undefined, hasErrors ? 207 : 200)
        })

        app.post(`${this.pathPrefix}/tables`, async (c) => {
            await this.init()
            const cfg = (await c.req.json()) as TableReplicationConfig
            await this.addTable(cfg)
            return createResponse({ added: cfg.tableName }, undefined, 201)
        })

        app.delete(`${this.pathPrefix}/tables/:table`, async (c) => {
            await this.init()
            const tableName = c.req.param('table')
            await this.removeTable(tableName)
            return createResponse({ removed: tableName }, undefined, 200)
        })

        app.post(`${this.pathPrefix}/callback`, async () => {
            await this.init()
            const results = await this.syncAll()
            await this.scheduleNextSync()
            return createResponse({ results }, undefined, 200)
        })
    }

    public async init(): Promise<void> {
        if (!this.dataSource?.rpc) return

        await this.dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.CREATE_STATE_TABLE,
            params: [],
        })

        for (const cfg of this.tables.values()) {
            const existing = await this.getTableState(cfg.tableName)
            if (!existing) {
                await this.saveTableState({
                    table_name: cfg.tableName,
                    target_table: cfg.targetTable ?? cfg.tableName,
                    cursor_column: cfg.cursorColumn ?? null,
                    last_cursor_value: null,
                    primary_key: cfg.primaryKey ?? 'id',
                    sync_mode: cfg.cursorColumn ? 'incremental' : 'full',
                    rows_replicated: 0,
                    status: 'pending',
                    last_error: null,
                    retry_count: 0,
                    last_synced_at: null,
                })
            }
        }
    }

    public async addTable(cfg: TableReplicationConfig): Promise<void> {
        this.validateTableConfig(cfg)
        this.tables.set(cfg.tableName, cfg)
        if (!this.dataSource?.rpc) return

        await this.dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.CREATE_STATE_TABLE,
            params: [],
        })
        const existing = await this.getTableState(cfg.tableName)
        await this.saveTableState({
            table_name: cfg.tableName,
            target_table: cfg.targetTable ?? cfg.tableName,
            cursor_column: cfg.cursorColumn ?? null,
            last_cursor_value: existing?.last_cursor_value ?? null,
            primary_key: cfg.primaryKey ?? 'id',
            sync_mode: cfg.cursorColumn ? 'incremental' : 'full',
            rows_replicated: existing?.rows_replicated ?? 0,
            status: existing?.status ?? 'pending',
            last_error: existing?.last_error ?? null,
            retry_count: existing?.retry_count ?? 0,
            last_synced_at: existing?.last_synced_at ?? null,
        })
    }

    public async removeTable(tableName: string): Promise<void> {
        assertValidIdentifier(tableName, 'tableName')
        this.tables.delete(tableName)
        if (!this.dataSource?.rpc) return

        await this.dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.DELETE_STATE,
            params: [tableName],
        })
    }

    public async getStatus(): Promise<ReplicationStateRow[]> {
        if (!this.dataSource?.rpc) return []
        const rows = (await this.dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.GET_ALL_STATES,
            params: [],
        })) as QueryResult[]
        return rows as unknown as ReplicationStateRow[]
    }

    public async scheduleNextSync(): Promise<number | null> {
        if (!this.dataSource?.rpc?.setAlarm) return null

        let nextRunMs: number | null = null
        if (this.cronTab) {
            const interval = cronParser.parseExpression(this.cronTab, {
                currentDate: new Date(),
            })
            nextRunMs = interval.next().getTime()
        } else if (this.syncIntervalMs && this.syncIntervalMs > 0) {
            nextRunMs = Date.now() + this.syncIntervalMs
        }

        if (nextRunMs !== null) {
            await this.dataSource.rpc.setAlarm(nextRunMs)
        }
        return nextRunMs
    }

    public async syncAll(opts?: { fullRefresh?: boolean }): Promise<TableSyncResult[]> {
        if (this.syncing) {
            throw new Error('Replication sync already in progress')
        }
        this.syncing = true
        const results: TableSyncResult[] = []

        try {
            for (const tableName of this.tables.keys()) {
                results.push(await this.syncTable(tableName, opts))
            }
        } finally {
            this.syncing = false
        }

        return results
    }

    public async syncTable(
        tableName: string,
        opts?: { fullRefresh?: boolean }
    ): Promise<TableSyncResult> {
        const cfg = this.tables.get(tableName)
        if (!cfg) {
            throw new Error(`Table "${tableName}" is not configured for replication`)
        }
        if (!this.dataSource?.rpc) {
            throw new Error('ReplicationPlugin requires an initialized internal dataSource')
        }

        const targetTable = cfg.targetTable ?? cfg.tableName
        const primaryKey = cfg.primaryKey ?? 'id'
        const batchSize = cfg.batchSize ?? this.defaultBatchSize
        const fullRefresh = opts?.fullRefresh ?? cfg.fullRefresh ?? !cfg.cursorColumn

        const prevState = await this.getTableState(tableName)
        let cursorValue = fullRefresh ? null : prevState?.last_cursor_value ?? null
        let totalRows = 0
        const addedColumns: string[] = []

        await this.saveTableState({
            table_name: tableName,
            target_table: targetTable,
            cursor_column: cfg.cursorColumn ?? null,
            last_cursor_value: cursorValue,
            primary_key: primaryKey,
            sync_mode: cfg.cursorColumn && !fullRefresh ? 'incremental' : 'full',
            rows_replicated: prevState?.rows_replicated ?? 0,
            status: 'syncing',
            last_error: null,
            retry_count: prevState?.retry_count ?? 0,
            last_synced_at: prevState?.last_synced_at ?? null,
        })

        let lastAttemptError: unknown = null
        for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
            try {
                const syncOutcome = await this.executeSyncLoop({
                    cfg,
                    targetTable,
                    primaryKey,
                    batchSize,
                    initialCursor: cursorValue,
                    fullRefresh,
                })
                totalRows = syncOutcome.rowsSynced
                cursorValue = syncOutcome.lastCursor
                addedColumns.push(...syncOutcome.columnsAdded)

                const nowIso = new Date().toISOString()
                await this.saveTableState({
                    table_name: tableName,
                    target_table: targetTable,
                    cursor_column: cfg.cursorColumn ?? null,
                    last_cursor_value: cursorValue,
                    primary_key: primaryKey,
                    sync_mode: cfg.cursorColumn && !fullRefresh ? 'incremental' : 'full',
                    rows_replicated: (fullRefresh ? 0 : prevState?.rows_replicated ?? 0) + totalRows,
                    status: 'idle',
                    last_error: null,
                    retry_count: 0,
                    last_synced_at: nowIso,
                })

                return {
                    tableName,
                    targetTable,
                    rowsSynced: totalRows,
                    lastCursor: cursorValue,
                    columnsAdded: addedColumns,
                    status: 'success',
                }
            } catch (err) {
                lastAttemptError = err
                if (attempt < this.maxRetries && this.retryDelayMs > 0) {
                    const backoff = this.retryDelayMs * Math.pow(2, attempt)
                    await new Promise((resolve) => setTimeout(resolve, backoff))
                }
            }
        }

        const errorMsg =
            lastAttemptError instanceof Error ? lastAttemptError.message : String(lastAttemptError)
        await this.saveTableState({
            table_name: tableName,
            target_table: targetTable,
            cursor_column: cfg.cursorColumn ?? null,
            last_cursor_value: cursorValue,
            primary_key: primaryKey,
            sync_mode: cfg.cursorColumn && !fullRefresh ? 'incremental' : 'full',
            rows_replicated: prevState?.rows_replicated ?? 0,
            status: 'error',
            last_error: errorMsg,
            retry_count: (prevState?.retry_count ?? 0) + 1,
            last_synced_at: prevState?.last_synced_at ?? null,
        })

        return {
            tableName,
            targetTable,
            rowsSynced: 0,
            lastCursor: cursorValue,
            columnsAdded: [],
            status: 'error',
            error: errorMsg,
        }
    }

    private async executeSyncLoop(opts: {
        cfg: TableReplicationConfig
        targetTable: string
        primaryKey: string
        batchSize: number
        initialCursor: string | null
        fullRefresh: boolean
    }): Promise<{ rowsSynced: number; lastCursor: string | null; columnsAdded: string[] }> {
        const { cfg, targetTable, primaryKey, batchSize, fullRefresh } = opts
        const dialect = this.dataSource?.external?.dialect
        const config = this.config ?? { role: 'admin' }
        const extTable = quoteExternalTable(cfg.tableName, dialect, cfg.schema)

        let cursorValue = opts.initialCursor
        let offset = 0
        let totalRows = 0
        let targetCleared = false
        const columnsAdded: string[] = []

        while (true) {
            const params: unknown[] = []
            const conditions: string[] = []

            if (cfg.whereClause) {
                conditions.push(`(${cfg.whereClause})`)
            }

            if (cfg.cursorColumn && cursorValue !== null) {
                const cursorCol = quoteExternalCol(cfg.cursorColumn, dialect)
                conditions.push(`${cursorCol} > ${placeholderFor(dialect, params.length)}`)
                params.push(cursorValue)
            }

            const whereSql = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''
            const orderCol = quoteExternalCol(cfg.cursorColumn ?? primaryKey, dialect)
            const useOffset = !cfg.cursorColumn
            const limitClause = useOffset
                ? ` LIMIT ${batchSize} OFFSET ${offset}`
                : ` LIMIT ${batchSize}`
            const sql = `SELECT * FROM ${extTable}${whereSql} ORDER BY ${orderCol} ASC${limitClause}`

            const rawResult = await this.externalQueryFn({
                sql,
                params,
                dataSource: this.dataSource!,
                config,
            })
            const rows = normalizeRows(rawResult)

            if (rows.length === 0) {
                break
            }

            const newCols = await this.ensureTargetSchema(targetTable, primaryKey, rows)
            for (const col of newCols) {
                if (!columnsAdded.includes(col)) columnsAdded.push(col)
            }

            if (fullRefresh && !targetCleared) {
                await this.dataSource!.rpc.executeQuery({
                    sql: `DELETE FROM ${quoteSqliteIdent(targetTable)}`,
                    params: [],
                })
                targetCleared = true
            }

            await this.upsertBatch(targetTable, primaryKey, rows)
            totalRows += rows.length

            if (cfg.cursorColumn) {
                const lastRow = rows[rows.length - 1]
                const nextCursor = lastRow[cfg.cursorColumn]
                if (nextCursor !== undefined && nextCursor !== null) {
                    cursorValue =
                        nextCursor instanceof Date ? nextCursor.toISOString() : String(nextCursor)
                }
            } else {
                offset += rows.length
            }

            if (rows.length < batchSize) {
                break
            }
        }

        return { rowsSynced: totalRows, lastCursor: cursorValue, columnsAdded }
    }

    private extractColumnNames(rows: Record<string, any>[]): string[] {
        const set = new Set<string>()
        for (const row of rows) {
            for (const key of Object.keys(row)) {
                set.add(assertValidIdentifier(key, 'column'))
            }
        }
        return Array.from(set)
    }

    private async ensureTargetSchema(
        targetTable: string,
        primaryKey: string,
        rows: Record<string, any>[]
    ): Promise<string[]> {
        const quotedTable = quoteSqliteIdent(targetTable)
        const columnNames = this.extractColumnNames(rows)

        const columnTypes = new Map<string, string>()
        for (const col of columnNames) {
            const sampleValues = rows.map((r) => r[col])
            columnTypes.set(col, inferSqliteColumnType(sampleValues))
        }

        const existingInfo = (await this.dataSource!.rpc.executeQuery({
            sql: `PRAGMA table_info(${quotedTable})`,
            params: [],
        })) as Record<string, any>[]

        if (!existingInfo || existingInfo.length === 0) {
            const colDefs = columnNames.map((col) => {
                const colType = columnTypes.get(col) ?? 'TEXT'
                const pkSuffix = col === primaryKey ? ' PRIMARY KEY' : ''
                return `${quoteSqliteIdent(col)} ${colType}${pkSuffix}`
            })
            await this.dataSource!.rpc.executeQuery({
                sql: `CREATE TABLE IF NOT EXISTS ${quotedTable} (${colDefs.join(', ')})`,
                params: [],
            })
            return []
        }

        const existingColNames = new Set(existingInfo.map((info) => String(info.name)))
        const added: string[] = []

        for (const col of columnNames) {
            if (!existingColNames.has(col)) {
                const colType = columnTypes.get(col) ?? 'TEXT'
                await this.dataSource!.rpc.executeQuery({
                    sql: `ALTER TABLE ${quotedTable} ADD COLUMN ${quoteSqliteIdent(col)} ${colType}`,
                    params: [],
                })
                added.push(col)
            }
        }

        return added
    }

    private async upsertBatch(
        targetTable: string,
        primaryKey: string,
        rows: Record<string, any>[]
    ): Promise<void> {
        const quotedTable = quoteSqliteIdent(targetTable)
        const columns = this.extractColumnNames(rows)
        const quotedCols = columns.map(quoteSqliteIdent).join(', ')
        const placeholders = columns.map(() => '?').join(', ')

        const hasPk = columns.includes(primaryKey)
        const nonPkCols = columns.filter((c) => c !== primaryKey)
        const sql =
            hasPk && nonPkCols.length > 0
                ? `INSERT INTO ${quotedTable} (${quotedCols}) VALUES (${placeholders}) ON CONFLICT(${quoteSqliteIdent(primaryKey)}) DO UPDATE SET ${nonPkCols
                      .map((c) => `${quoteSqliteIdent(c)} = excluded.${quoteSqliteIdent(c)}`)
                      .join(', ')}`
                : `INSERT OR REPLACE INTO ${quotedTable} (${quotedCols}) VALUES (${placeholders})`

        for (const row of rows) {
            const params = columns.map((col) => serializeSqliteValue(row[col]))
            await this.dataSource!.rpc.executeQuery({ sql, params })
        }
    }

    private async getTableState(tableName: string): Promise<ReplicationStateRow | null> {
        if (!this.dataSource?.rpc) return null
        const rows = (await this.dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.GET_STATE,
            params: [tableName],
        })) as Record<string, any>[]
        return rows.length > 0 ? (rows[0] as ReplicationStateRow) : null
    }

    private async saveTableState(
        state: Omit<ReplicationStateRow, 'updated_at'>
    ): Promise<void> {
        if (!this.dataSource?.rpc) return
        await this.dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.UPSERT_STATE,
            params: [
                state.table_name,
                state.target_table,
                state.cursor_column,
                state.last_cursor_value,
                state.primary_key,
                state.sync_mode,
                state.rows_replicated,
                state.status,
                state.last_error,
                state.retry_count,
                state.last_synced_at,
            ],
        })
    }
}
