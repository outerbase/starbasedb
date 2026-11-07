import { StarbaseApp, StarbaseDBConfiguration } from '../../src/handler'
import { executeExternalQuery } from '../../src/operation'
import { StarbasePlugin } from '../../src/plugin'
import { DataSource, ExternalDatabaseSource, QueryResult } from '../../src/types'
import { createResponse } from '../../src/utils'

// Replication table configuration defines how an external table maps into local Durable Object SQLite storage.
export interface ReplicationTableConfig {
    table: string
    targetTable?: string
    cursorColumn?: string
    primaryKey?: string
    batchSize?: number
    createTableSql?: string
}

// Options controlling external-to-internal pull replication intervals and source credentials.
export interface ReplicationPluginOptions {
    tables: (string | ReplicationTableConfig)[]
    intervalMs?: number
    external?: ExternalDatabaseSource
    outerbaseApiKey?: string
    autoStart?: boolean
}

export interface ReplicationSyncSummary {
    table: string
    targetTable: string
    rowsSynced: number
    lastCursorValue: string | number | null
}

interface ReplicationRuntimeContext {
    dataSource: DataSource
    config: StarbaseDBConfiguration
}

interface ReplicationBatchContext {
    dataSource: DataSource
    tableConfig: ReturnType<typeof normalizeTableConfig>
    rows: Record<string, unknown>[]
    priorState: { lastCursorValue: string | null; rowsSynced: number }
}

const REPLICATION_SQL = {
    CREATE_STATE_TABLE: `
        CREATE TABLE IF NOT EXISTS tmp_replication_state (
            table_name TEXT NOT NULL UNIQUE PRIMARY KEY,
            source_table TEXT NOT NULL,
            cursor_column TEXT,
            last_cursor_value TEXT,
            rows_synced INTEGER NOT NULL DEFAULT 0,
            last_synced_at INTEGER NOT NULL
        )
    `,
    GET_TABLE_STATE: `
        SELECT table_name, source_table, cursor_column, last_cursor_value, rows_synced, last_synced_at
        FROM tmp_replication_state
        WHERE table_name = ?
    `,
    GET_ALL_STATE: `
        SELECT table_name, source_table, cursor_column, last_cursor_value, rows_synced, last_synced_at
        FROM tmp_replication_state
        ORDER BY table_name ASC
    `,
    UPSERT_STATE: `
        INSERT OR REPLACE INTO tmp_replication_state (
            table_name,
            source_table,
            cursor_column,
            last_cursor_value,
            rows_synced,
            last_synced_at
        ) VALUES (?, ?, ?, ?, ?, ?)
    `,
}

// Normalizes shorthand table names into explicit table replication descriptors.
export function normalizeTableConfig(
    input: string | ReplicationTableConfig
): Required<Omit<ReplicationTableConfig, 'cursorColumn' | 'createTableSql'>> & {
    cursorColumn?: string
    createTableSql?: string
} {
    if (typeof input === 'string') {
        return {
            table: input,
            targetTable: input,
            primaryKey: 'id',
            batchSize: 500,
        }
    }
    return {
        table: input.table,
        targetTable: input.targetTable || input.table,
        cursorColumn: input.cursorColumn,
        primaryKey: input.primaryKey || input.cursorColumn || 'id',
        batchSize: input.batchSize ?? 500,
        createTableSql: input.createTableSql,
    }
}

// Validates SQL identifiers to prevent injection when constructing replica DDL and DML statements.
function sanitizeSqlIdentifier(identifier: string): string {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
        throw new Error(`Invalid SQL identifier: ${identifier}`)
    }
    return `"${identifier}"`
}

// Maps JavaScript runtime values from external query payloads to SQLite column affinities.
function inferSqliteColumnType(value: unknown): string {
    if (typeof value === 'number') {
        return Number.isInteger(value) ? 'INTEGER' : 'REAL'
    }
    if (typeof value === 'boolean') {
        return 'INTEGER'
    }
    return 'TEXT'
}

// Generates a deterministic CREATE TABLE IF NOT EXISTS statement from a sample external row.
export function buildReplicaTableDdl(
    tableConfig: ReturnType<typeof normalizeTableConfig>,
    sampleRow: Record<string, unknown>
): string {
    if (tableConfig.createTableSql) {
        return tableConfig.createTableSql
    }
    const target = sanitizeSqlIdentifier(tableConfig.targetTable)
    const columns = Object.entries(sampleRow).map(([col, val]) => {
        const colIdent = sanitizeSqlIdentifier(col)
        const colType = inferSqliteColumnType(val)
        const pkSuffix = col === tableConfig.primaryKey ? ' PRIMARY KEY' : ''
        return `${colIdent} ${colType}${pkSuffix}`
    })
    return `CREATE TABLE IF NOT EXISTS ${target} (${columns.join(', ')})`
}

// Builds the parameterized SELECT statement for append-only watermark polling against the external source.
export function buildExternalPollQuery(
    tableConfig: ReturnType<typeof normalizeTableConfig>,
    lastCursorValue: string | null
): { sql: string; params: unknown[] } {
    const sourceIdent = sanitizeSqlIdentifier(tableConfig.table)
    if (!tableConfig.cursorColumn) {
        return {
            sql: `SELECT * FROM ${sourceIdent} LIMIT ${tableConfig.batchSize}`,
            params: [],
        }
    }
    const cursorIdent = sanitizeSqlIdentifier(tableConfig.cursorColumn)
    if (lastCursorValue !== null && lastCursorValue !== undefined) {
        return {
            sql: `SELECT * FROM ${sourceIdent} WHERE ${cursorIdent} > ? ORDER BY ${cursorIdent} ASC LIMIT ${tableConfig.batchSize}`,
            params: [lastCursorValue],
        }
    }
    return {
        sql: `SELECT * FROM ${sourceIdent} ORDER BY ${cursorIdent} ASC LIMIT ${tableConfig.batchSize}`,
        params: [],
    }
}

// Converts a batch of external rows into parameterized SQLite INSERT OR REPLACE statements.
function buildUpsertQueries(
    targetTable: string,
    rows: Record<string, unknown>[]
): { sql: string; params: unknown[] }[] {
    if (rows.length === 0) return []
    const targetIdent = sanitizeSqlIdentifier(targetTable)
    const columns = Object.keys(rows[0])
    const columnList = columns.map(sanitizeSqlIdentifier).join(', ')
    const placeholders = columns.map(() => '?').join(', ')
    const sql = `INSERT OR REPLACE INTO ${targetIdent} (${columnList}) VALUES (${placeholders})`

    return rows.map((row) => ({
        sql,
        params: columns.map((col) => {
            const val = row[col]
            if (val !== null && typeof val === 'object') {
                return JSON.stringify(val)
            }
            return val ?? null
        }),
    }))
}

export class ReplicationPlugin extends StarbasePlugin {
    public pathPrefix: string = '/replication'
    private options: ReplicationPluginOptions
    private dataSource?: DataSource
    private config?: StarbaseDBConfiguration

    constructor(options: ReplicationPluginOptions) {
        super(
            'starbasedb:replication',
            { requiresAuth: true },
            '/replication'
        )
        this.options = options
    }

    override async register(app: StarbaseApp): Promise<void> {
        app.use(async (c, next) => {
            this.dataSource = c?.get('dataSource')
            this.config = c?.get('config')
            await this.ensureStateTable()
            if (this.options.autoStart !== false) {
                await this.scheduleNextSync()
            }
            await next()
        })

        app.post(`${this.pathPrefix}/sync`, async (c) => {
            const body = await c.req.json().catch(() => ({}))
            const targetName =
                typeof body?.table === 'string' ? body.table : undefined
            const summaries = targetName
                ? [await this.syncTableByName(targetName)]
                : await this.syncAllTables()
            return createResponse({ tables: summaries }, undefined, 200)
        })

        app.get(`${this.pathPrefix}/status`, async () => {
            const state = await this.getReplicationStatus()
            return createResponse({ tables: state }, undefined, 200)
        })
    }

    private resolveRuntime(
        override?: Partial<ReplicationRuntimeContext>
    ): ReplicationRuntimeContext {
        const baseDataSource = override?.dataSource ?? this.dataSource
        if (!baseDataSource) {
            throw new Error('ReplicationPlugin dataSource is not initialized.')
        }
        const mergedDataSource: DataSource = {
            ...baseDataSource,
            external: this.options.external ?? baseDataSource.external,
        }
        const mergedConfig: StarbaseDBConfiguration = {
            ...(override?.config ?? this.config ?? { role: 'admin' }),
            outerbaseApiKey:
                this.options.outerbaseApiKey ??
                override?.config?.outerbaseApiKey ??
                this.config?.outerbaseApiKey,
        }
        return { dataSource: mergedDataSource, config: mergedConfig }
    }

    public async ensureStateTable(
        runtimeOverride?: Partial<ReplicationRuntimeContext>
    ): Promise<void> {
        const { dataSource } = this.resolveRuntime(runtimeOverride)
        await dataSource.rpc.executeQuery({
            sql: REPLICATION_SQL.CREATE_STATE_TABLE,
            params: [],
        })
    }

    public async getReplicationStatus(
        runtimeOverride?: Partial<ReplicationRuntimeContext>
    ): Promise<QueryResult[]> {
        const { dataSource } = this.resolveRuntime(runtimeOverride)
        await this.ensureStateTable(runtimeOverride)
        return (await dataSource.rpc.executeQuery({
            sql: REPLICATION_SQL.GET_ALL_STATE,
            params: [],
        })) as QueryResult[]
    }

    public async scheduleNextSync(
        runtimeOverride?: Partial<ReplicationRuntimeContext>
    ): Promise<void> {
        const intervalMs = this.options.intervalMs ?? 60000
        if (intervalMs <= 0) return
        const { dataSource } = this.resolveRuntime(runtimeOverride)
        if (typeof dataSource.rpc.setAlarm === 'function') {
            await dataSource.rpc.setAlarm(Date.now() + intervalMs)
        }
    }

    public async syncAllTables(
        runtimeOverride?: Partial<ReplicationRuntimeContext>
    ): Promise<ReplicationSyncSummary[]> {
        const summaries: ReplicationSyncSummary[] = []
        for (const tableEntry of this.options.tables) {
            const summary = await this.syncTable(tableEntry, runtimeOverride)
            summaries.push(summary)
        }
        await this.scheduleNextSync(runtimeOverride)
        return summaries
    }

    private async syncTableByName(
        tableName: string
    ): Promise<ReplicationSyncSummary> {
        const matched = this.options.tables.find((entry) => {
            const cfg = normalizeTableConfig(entry)
            return cfg.table === tableName || cfg.targetTable === tableName
        })
        if (!matched) {
            throw new Error(`Table ${tableName} is not configured for replication.`)
        }
        return this.syncTable(matched)
    }

    public async syncTable(
        tableInput: string | ReplicationTableConfig,
        runtimeOverride?: Partial<ReplicationRuntimeContext>
    ): Promise<ReplicationSyncSummary> {
        const runtime = this.resolveRuntime(runtimeOverride)
        await this.ensureStateTable(runtime)
        const tableConfig = normalizeTableConfig(tableInput)
        const priorState = await this.readTableWatermark(
            runtime.dataSource,
            tableConfig.targetTable
        )

        const pollQuery = buildExternalPollQuery(
            tableConfig,
            priorState.lastCursorValue
        )
        const externalRows = (await executeExternalQuery({
            sql: pollQuery.sql,
            params: pollQuery.params,
            dataSource: runtime.dataSource,
            config: runtime.config,
        })) as Record<string, unknown>[]

        const rows = Array.isArray(externalRows) ? externalRows : []
        const newCursor = await this.applyReplicatedBatch({
            dataSource: runtime.dataSource,
            tableConfig,
            rows,
            priorState,
        })

        return {
            table: tableConfig.table,
            targetTable: tableConfig.targetTable,
            rowsSynced: rows.length,
            lastCursorValue: newCursor,
        }
    }

    private async readTableWatermark(
        dataSource: DataSource,
        targetTable: string
    ): Promise<{ lastCursorValue: string | null; rowsSynced: number }> {
        const rows = (await dataSource.rpc.executeQuery({
            sql: REPLICATION_SQL.GET_TABLE_STATE,
            params: [targetTable],
        })) as Record<string, unknown>[]

        if (!Array.isArray(rows) || rows.length === 0) {
            return { lastCursorValue: null, rowsSynced: 0 }
        }
        const rawCursor = rows[0].last_cursor_value
        return {
            lastCursorValue:
                rawCursor !== null && rawCursor !== undefined
                    ? String(rawCursor)
                    : null,
            rowsSynced: Number(rows[0].rows_synced ?? 0),
        }
    }

    private resolveBatchCursor(
        batch: ReplicationBatchContext
    ): string | null {
        const { tableConfig, rows, priorState } = batch
        if (rows.length === 0 || !tableConfig.cursorColumn) {
            return priorState.lastCursorValue
        }
        const lastRow = rows[rows.length - 1]
        const cursorVal = lastRow[tableConfig.cursorColumn]
        if (cursorVal === undefined || cursorVal === null) {
            return priorState.lastCursorValue
        }
        return String(cursorVal)
    }

    private async persistReplicatedRows(
        batch: ReplicationBatchContext
    ): Promise<void> {
        const { dataSource, tableConfig, rows } = batch
        if (rows.length === 0) return

        const ddl = buildReplicaTableDdl(tableConfig, rows[0])
        await dataSource.rpc.executeQuery({ sql: ddl, params: [] })

        const upserts = buildUpsertQueries(tableConfig.targetTable, rows)
        for (const query of upserts) {
            await dataSource.rpc.executeQuery(query)
        }
    }

    private async applyReplicatedBatch(
        batch: ReplicationBatchContext
    ): Promise<string | null> {
        const { dataSource, tableConfig, rows, priorState } = batch
        await this.persistReplicatedRows(batch)
        const latestCursor = this.resolveBatchCursor(batch)

        await dataSource.rpc.executeQuery({
            sql: REPLICATION_SQL.UPSERT_STATE,
            params: [
                tableConfig.targetTable,
                tableConfig.table,
                tableConfig.cursorColumn ?? null,
                latestCursor,
                priorState.rowsSynced + rows.length,
                Date.now(),
            ],
        })

        return latestCursor
    }
}
