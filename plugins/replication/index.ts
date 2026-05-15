import { StarbaseApp, StarbaseDBConfiguration } from '../../src/handler'
import { executeExternalQuery } from '../../src/operation'
import { StarbasePlugin } from '../../src/plugin'
import { DataSource, QueryResult } from '../../src/types'
import { createResponse } from '../../src/utils'

const SQL_QUERIES = {
    CREATE_STATE_TABLE: `
        CREATE TABLE IF NOT EXISTS tmp_starbasedb_replication_state (
            table_name TEXT PRIMARY KEY,
            last_cursor_value TEXT,
            last_cursor_type TEXT,
            last_synced_at TEXT,
            total_rows_synced INTEGER NOT NULL DEFAULT 0,
            last_error TEXT
        )
    `,
    CREATE_RUNS_TABLE: `
        CREATE TABLE IF NOT EXISTS tmp_starbasedb_replication_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            table_name TEXT NOT NULL,
            started_at TEXT NOT NULL,
            finished_at TEXT NOT NULL,
            rows_read INTEGER NOT NULL,
            rows_written INTEGER NOT NULL,
            cursor_start TEXT,
            cursor_end TEXT,
            error TEXT
        )
    `,
    SELECT_STATE: `
        SELECT table_name, last_cursor_value, last_cursor_type, last_synced_at, total_rows_synced, last_error
        FROM tmp_starbasedb_replication_state
        WHERE table_name = ?
    `,
    SELECT_ALL_STATE: `
        SELECT table_name, last_cursor_value, last_cursor_type, last_synced_at, total_rows_synced, last_error
        FROM tmp_starbasedb_replication_state
        ORDER BY table_name
    `,
    UPSERT_STATE: `
        INSERT INTO tmp_starbasedb_replication_state (
            table_name, last_cursor_value, last_cursor_type, last_synced_at, total_rows_synced, last_error
        ) VALUES (?, ?, ?, ?, ?, NULL)
        ON CONFLICT(table_name) DO UPDATE SET
            last_cursor_value = excluded.last_cursor_value,
            last_cursor_type = excluded.last_cursor_type,
            last_synced_at = excluded.last_synced_at,
            total_rows_synced = excluded.total_rows_synced,
            last_error = NULL
    `,
    UPDATE_STATE_ERROR: `
        INSERT INTO tmp_starbasedb_replication_state (
            table_name, last_synced_at, total_rows_synced, last_error
        ) VALUES (?, ?, 0, ?)
        ON CONFLICT(table_name) DO UPDATE SET
            last_synced_at = excluded.last_synced_at,
            last_error = excluded.last_error
    `,
    INSERT_RUN: `
        INSERT INTO tmp_starbasedb_replication_runs (
            table_name, started_at, finished_at, rows_read, rows_written, cursor_start, cursor_end, error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `,
}

type ExternalExecutor = typeof executeExternalQuery

export type ReplicationMode =
    | 'upsert'
    | 'replace'
    | 'insert'
    | 'insert-or-ignore'

export type CursorValueType = 'number' | 'string' | 'date'

export interface ReplicationTableOptions {
    sourceTable: string
    targetTable?: string
    columns?: string[]
    cursorColumn?: string
    cursorValueType?: CursorValueType
    primaryKey?: string | string[]
    where?: string
    batchSize?: number
    intervalSeconds?: number
    mode?: ReplicationMode
    transform?: (
        row: Record<string, unknown>
    ) => Record<string, unknown> | Promise<Record<string, unknown>>
}

export interface ReplicationPluginOptions {
    tables: ReplicationTableOptions[]
    autoPull?: boolean
    defaultBatchSize?: number
    defaultIntervalSeconds?: number
    failQueriesOnError?: boolean
    continueOnTableError?: boolean
    pathPrefix?: string
    externalExecutor?: ExternalExecutor
}

export interface ReplicationResult {
    table: string
    sourceTable: string
    targetTable: string
    skipped: boolean
    rowsRead: number
    rowsWritten: number
    cursorStart?: string | null
    cursorEnd?: string | null
    error?: string
}

type ReplicationStateRow = QueryResult & {
    table_name: string
    last_cursor_value?: string | null
    last_cursor_type?: CursorValueType | null
    last_synced_at?: string | null
    total_rows_synced?: number | string | null
    last_error?: string | null
}

type NormalizedTableOptions = Required<
    Pick<ReplicationTableOptions, 'sourceTable' | 'targetTable'>
> &
    Omit<ReplicationTableOptions, 'sourceTable' | 'targetTable'> & {
        batchSize: number
        intervalSeconds: number
        primaryKey: string[]
        mode: ReplicationMode
    }

const IDENTIFIER_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/

export class ReplicationPlugin extends StarbasePlugin {
    public pathPrefix: string
    private readonly tables: NormalizedTableOptions[]
    private readonly autoPull: boolean
    private readonly failQueriesOnError: boolean
    private readonly continueOnTableError: boolean
    private readonly externalExecutor: ExternalExecutor
    private dataSource?: DataSource
    private config?: StarbaseDBConfiguration
    private initialized = false
    private initPromise?: Promise<void>
    private inFlightSyncs = new Map<string, Promise<ReplicationResult>>()

    constructor(opts: ReplicationPluginOptions) {
        super('starbasedb:replication', { requiresAuth: true })

        if (!opts.tables.length) {
            throw new Error('ReplicationPlugin requires at least one table.')
        }

        this.pathPrefix = opts.pathPrefix ?? '/replication'
        this.autoPull = opts.autoPull ?? true
        this.failQueriesOnError = opts.failQueriesOnError ?? false
        this.continueOnTableError = opts.continueOnTableError ?? true
        this.externalExecutor = opts.externalExecutor ?? executeExternalQuery
        this.tables = opts.tables.map((table) =>
            this.normalizeTableOptions(table, opts)
        )
    }

    override async register(app: StarbaseApp) {
        app.use(async (c, next) => {
            this.dataSource = c.get('dataSource')
            this.config = c.get('config')
            await next()
        })

        app.get(`${this.pathPrefix}/status`, async () => {
            if (!this.dataSource) {
                return createResponse(
                    undefined,
                    'ReplicationPlugin has not been initialized.',
                    500
                )
            }

            await this.ensureInitialized(this.dataSource)
            const state = await this.readAllState(this.dataSource)

            return createResponse(
                {
                    configuredTables: this.tables.map((table) => ({
                        sourceTable: table.sourceTable,
                        targetTable: table.targetTable,
                        cursorColumn: table.cursorColumn,
                        batchSize: table.batchSize,
                        intervalSeconds: table.intervalSeconds,
                        mode: table.mode,
                    })),
                    state,
                },
                undefined,
                200
            )
        })

        app.post(`${this.pathPrefix}/pull`, async (c) => {
            if (!this.dataSource || !this.config) {
                return createResponse(
                    undefined,
                    'ReplicationPlugin has not been initialized.',
                    500
                )
            }

            const body = await this.safeJson<{ tables?: string[] }>(c.req.raw)
            const result = await this.sync({
                dataSource: this.dataSource,
                config: this.config,
                force: true,
                tableNames: body?.tables,
            })

            return createResponse(result, undefined, this.hasError(result) ? 500 : 200)
        })

        app.post(`${this.pathPrefix}/pull/:tableName`, async (c) => {
            if (!this.dataSource || !this.config) {
                return createResponse(
                    undefined,
                    'ReplicationPlugin has not been initialized.',
                    500
                )
            }

            const tableName = c.req.param('tableName')
            const result = await this.sync({
                dataSource: this.dataSource,
                config: this.config,
                force: true,
                tableNames: [tableName],
            })

            return createResponse(result, undefined, this.hasError(result) ? 500 : 200)
        })
    }

    override async beforeQuery(opts: {
        sql: string
        params?: unknown[]
        dataSource?: DataSource
        config?: StarbaseDBConfiguration
    }): Promise<{ sql: string; params?: unknown[] }> {
        if (!this.autoPull || !opts.dataSource || !opts.config) {
            return { sql: opts.sql, params: opts.params }
        }

        try {
            await this.sync({
                dataSource: opts.dataSource,
                config: opts.config,
                force: false,
            })
        } catch (error) {
            console.error('ReplicationPlugin beforeQuery failed:', error)

            if (this.failQueriesOnError) {
                throw error
            }
        }

        return { sql: opts.sql, params: opts.params }
    }

    public async sync(opts: {
        dataSource: DataSource
        config: StarbaseDBConfiguration
        force?: boolean
        tableNames?: string[]
    }): Promise<ReplicationResult[]> {
        const { dataSource, config, force = false, tableNames } = opts

        await this.ensureInitialized(dataSource)

        const selectedTables = this.selectTables(tableNames)
        const results: ReplicationResult[] = []

        for (const table of selectedTables) {
            try {
                if (!force && !(await this.isDue(table, dataSource))) {
                    results.push(this.skippedResult(table))
                    continue
                }

                results.push(await this.syncTable(table, dataSource, config))
            } catch (error) {
                const message =
                    error instanceof Error ? error.message : String(error)
                await this.recordError(table, dataSource, message)
                results.push({
                    ...this.emptyResult(table),
                    skipped: false,
                    error: message,
                })

                if (!this.continueOnTableError) {
                    throw error
                }
            }
        }

        return results
    }

    private async syncTable(
        table: NormalizedTableOptions,
        dataSource: DataSource,
        config: StarbaseDBConfiguration
    ): Promise<ReplicationResult> {
        const key = this.tableKey(table)
        const existing = this.inFlightSyncs.get(key)

        if (existing) {
            return existing
        }

        const promise = this.runTableSync(table, dataSource, config).finally(
            () => {
                this.inFlightSyncs.delete(key)
            }
        )
        this.inFlightSyncs.set(key, promise)
        return promise
    }

    private async runTableSync(
        table: NormalizedTableOptions,
        dataSource: DataSource,
        config: StarbaseDBConfiguration
    ): Promise<ReplicationResult> {
        const startedAt = new Date().toISOString()
        const state = await this.readState(table, dataSource)
        const query = this.buildSelectQuery(table, state, dataSource)
        const externalRows = await this.externalExecutor({
            sql: query.sql,
            params: query.params,
            dataSource,
            config,
        })
        const rows = Array.isArray(externalRows)
            ? (externalRows as Record<string, unknown>[])
            : []
        const transformedRows = await this.transformRows(table, rows)
        const cursorEnd = this.findCursorEnd(table, rows, state)

        for (const row of transformedRows) {
            const insert = this.buildInsertQuery(table, row)
            await dataSource.rpc.executeQuery({
                sql: insert.sql,
                params: insert.params,
            })
        }

        await this.upsertState({
            table,
            dataSource,
            state,
            cursorEnd,
            rowsWritten: transformedRows.length,
        })

        const result: ReplicationResult = {
            table: this.tableKey(table),
            sourceTable: table.sourceTable,
            targetTable: table.targetTable,
            skipped: false,
            rowsRead: rows.length,
            rowsWritten: transformedRows.length,
            cursorStart: state?.last_cursor_value ?? null,
            cursorEnd: cursorEnd == null ? null : String(cursorEnd),
        }

        await this.recordRun(table, dataSource, {
            ...result,
            startedAt,
            finishedAt: new Date().toISOString(),
        })

        return result
    }

    private async ensureInitialized(dataSource: DataSource): Promise<void> {
        this.assertInternalReplicaDataSource(dataSource)

        if (this.initialized) {
            return
        }

        this.initPromise ??= (async () => {
            await dataSource.rpc.executeQuery({
                sql: SQL_QUERIES.CREATE_STATE_TABLE,
                params: [],
            })
            await dataSource.rpc.executeQuery({
                sql: SQL_QUERIES.CREATE_RUNS_TABLE,
                params: [],
            })
            this.initialized = true
        })()

        await this.initPromise
    }

    private assertInternalReplicaDataSource(dataSource: DataSource) {
        if (dataSource.source !== 'internal') {
            throw new Error(
                'ReplicationPlugin can only write to an internal StarbaseDB data source.'
            )
        }

        if (!dataSource.external) {
            throw new Error(
                'ReplicationPlugin requires dataSource.external to pull from an external source.'
            )
        }
    }

    private buildSelectQuery(
        table: NormalizedTableOptions,
        state: ReplicationStateRow | undefined,
        dataSource: DataSource
    ): { sql: string; params: unknown[] } {
        const quoteStyle =
            dataSource.external && 'dialect' in dataSource.external
                ? dataSource.external.dialect
                : 'sqlite'
        const columns = table.columns?.length
            ? table.columns.map((column) => this.quoteIdentifier(column, quoteStyle)).join(', ')
            : '*'
        const conditions: string[] = []
        const params: unknown[] = []

        if (table.where) {
            conditions.push(`(${table.where})`)
        }

        if (table.cursorColumn && state?.last_cursor_value != null) {
            conditions.push(
                `${this.quoteIdentifier(table.cursorColumn, quoteStyle)} > ?`
            )
            params.push(this.deserializeCursorValue(state))
        }

        const where = conditions.length
            ? ` WHERE ${conditions.join(' AND ')}`
            : ''
        const orderBy = table.cursorColumn
            ? ` ORDER BY ${this.quoteIdentifier(table.cursorColumn, quoteStyle)} ASC`
            : ''

        return {
            sql: `SELECT ${columns} FROM ${this.quoteQualifiedIdentifier(
                table.sourceTable,
                quoteStyle
            )}${where}${orderBy} LIMIT ${table.batchSize}`,
            params,
        }
    }

    private buildInsertQuery(
        table: NormalizedTableOptions,
        row: Record<string, unknown>
    ): { sql: string; params: unknown[] } {
        const columns = Object.keys(row)

        if (!columns.length) {
            throw new Error(
                `Replication row for ${table.targetTable} does not contain any columns.`
            )
        }

        const quotedColumns = columns.map((column) =>
            this.quoteIdentifier(column, 'sqlite')
        )
        const placeholders = columns.map(() => '?').join(', ')
        const params = columns.map((column) => row[column])
        const targetTable = this.quoteQualifiedIdentifier(
            table.targetTable,
            'sqlite'
        )

        if (table.mode === 'insert') {
            return {
                sql: `INSERT INTO ${targetTable} (${quotedColumns.join(
                    ', '
                )}) VALUES (${placeholders})`,
                params,
            }
        }

        if (table.mode === 'insert-or-ignore') {
            return {
                sql: `INSERT OR IGNORE INTO ${targetTable} (${quotedColumns.join(
                    ', '
                )}) VALUES (${placeholders})`,
                params,
            }
        }

        if (table.mode === 'replace' || table.primaryKey.length === 0) {
            return {
                sql: `INSERT OR REPLACE INTO ${targetTable} (${quotedColumns.join(
                    ', '
                )}) VALUES (${placeholders})`,
                params,
            }
        }

        const conflictColumns = table.primaryKey.map((column) =>
            this.quoteIdentifier(column, 'sqlite')
        )
        const updateColumns = columns.filter(
            (column) => !table.primaryKey.includes(column)
        )
        const conflictAction = updateColumns.length
            ? `DO UPDATE SET ${updateColumns
                  .map((column) => {
                      const quoted = this.quoteIdentifier(column, 'sqlite')
                      return `${quoted} = excluded.${quoted}`
                  })
                  .join(', ')}`
            : 'DO NOTHING'

        return {
            sql: `INSERT INTO ${targetTable} (${quotedColumns.join(
                ', '
            )}) VALUES (${placeholders}) ON CONFLICT (${conflictColumns.join(
                ', '
            )}) ${conflictAction}`,
            params,
        }
    }

    private async transformRows(
        table: NormalizedTableOptions,
        rows: Record<string, unknown>[]
    ): Promise<Record<string, unknown>[]> {
        if (!table.transform) {
            return rows
        }

        const transformedRows: Record<string, unknown>[] = []

        for (const row of rows) {
            transformedRows.push(await table.transform(row))
        }

        return transformedRows
    }

    private findCursorEnd(
        table: NormalizedTableOptions,
        rows: Record<string, unknown>[],
        state?: ReplicationStateRow
    ): unknown {
        if (!table.cursorColumn || rows.length === 0) {
            return state?.last_cursor_value ?? null
        }

        const cursorValues = rows
            .map((row) => row[table.cursorColumn as string])
            .filter((value) => value !== undefined && value !== null)

        if (!cursorValues.length) {
            return state?.last_cursor_value ?? null
        }

        return cursorValues.reduce((max, value) =>
            this.compareCursorValues(value, max, table.cursorValueType) > 0
                ? value
                : max
        )
    }

    private compareCursorValues(
        left: unknown,
        right: unknown,
        type: CursorValueType = 'string'
    ): number {
        if (type === 'number') {
            return Number(left) - Number(right)
        }

        const leftValue =
            type === 'date' ? new Date(String(left)).getTime() : String(left)
        const rightValue =
            type === 'date' ? new Date(String(right)).getTime() : String(right)

        if (leftValue > rightValue) return 1
        if (leftValue < rightValue) return -1
        return 0
    }

    private deserializeCursorValue(state: ReplicationStateRow): unknown {
        if (state.last_cursor_type === 'number') {
            return Number(state.last_cursor_value)
        }

        return state.last_cursor_value
    }

    private cursorTypeForValue(
        table: NormalizedTableOptions,
        value: unknown
    ): CursorValueType | null {
        if (value == null) {
            return table.cursorValueType ?? null
        }

        if (table.cursorValueType) {
            return table.cursorValueType
        }

        return typeof value === 'number' ? 'number' : 'string'
    }

    private async readState(
        table: NormalizedTableOptions,
        dataSource: DataSource
    ): Promise<ReplicationStateRow | undefined> {
        const rows = (await dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.SELECT_STATE,
            params: [this.tableKey(table)],
        })) as ReplicationStateRow[]

        return rows[0]
    }

    private async readAllState(dataSource: DataSource) {
        return (await dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.SELECT_ALL_STATE,
            params: [],
        })) as ReplicationStateRow[]
    }

    private async isDue(
        table: NormalizedTableOptions,
        dataSource: DataSource
    ): Promise<boolean> {
        const state = await this.readState(table, dataSource)

        if (!state?.last_synced_at) {
            return true
        }

        if (table.intervalSeconds <= 0) {
            return true
        }

        const lastSyncedAt = new Date(state.last_synced_at).getTime()
        return Date.now() - lastSyncedAt >= table.intervalSeconds * 1000
    }

    private async upsertState(opts: {
        table: NormalizedTableOptions
        dataSource: DataSource
        state?: ReplicationStateRow
        cursorEnd: unknown
        rowsWritten: number
    }) {
        const { table, dataSource, state, cursorEnd, rowsWritten } = opts
        const totalRowsSynced =
            Number(state?.total_rows_synced ?? 0) + rowsWritten
        const cursorType = this.cursorTypeForValue(table, cursorEnd)

        await dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.UPSERT_STATE,
            params: [
                this.tableKey(table),
                cursorEnd == null ? null : String(cursorEnd),
                cursorType,
                new Date().toISOString(),
                totalRowsSynced,
            ],
        })
    }

    private async recordRun(
        table: NormalizedTableOptions,
        dataSource: DataSource,
        result: ReplicationResult & { startedAt: string; finishedAt: string }
    ) {
        await dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.INSERT_RUN,
            params: [
                this.tableKey(table),
                result.startedAt,
                result.finishedAt,
                result.rowsRead,
                result.rowsWritten,
                result.cursorStart ?? null,
                result.cursorEnd ?? null,
                result.error ?? null,
            ],
        })
    }

    private async recordError(
        table: NormalizedTableOptions,
        dataSource: DataSource,
        error: string
    ) {
        const now = new Date().toISOString()
        await dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.UPDATE_STATE_ERROR,
            params: [this.tableKey(table), now, error],
        })
        await dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.INSERT_RUN,
            params: [this.tableKey(table), now, now, 0, 0, null, null, error],
        })
    }

    private normalizeTableOptions(
        table: ReplicationTableOptions,
        pluginOptions: ReplicationPluginOptions
    ): NormalizedTableOptions {
        this.validateQualifiedIdentifier(table.sourceTable)
        const targetTable =
            table.targetTable ?? table.sourceTable.split('.').at(-1) ?? ''
        this.validateQualifiedIdentifier(targetTable)

        table.columns?.forEach((column) => this.validateIdentifier(column))
        if (table.cursorColumn) {
            this.validateIdentifier(table.cursorColumn)
        }

        const primaryKey = Array.isArray(table.primaryKey)
            ? table.primaryKey
            : table.primaryKey
              ? [table.primaryKey]
              : table.cursorColumn
                ? [table.cursorColumn]
                : []
        primaryKey.forEach((column) => this.validateIdentifier(column))

        return {
            ...table,
            sourceTable: table.sourceTable,
            targetTable,
            primaryKey,
            batchSize: this.normalizePositiveInteger(
                table.batchSize ?? pluginOptions.defaultBatchSize ?? 500,
                'batchSize'
            ),
            intervalSeconds: this.normalizeNonNegativeInteger(
                table.intervalSeconds ??
                    pluginOptions.defaultIntervalSeconds ??
                    60,
                'intervalSeconds'
            ),
            mode: table.mode ?? 'upsert',
        }
    }

    private selectTables(tableNames?: string[]): NormalizedTableOptions[] {
        if (!tableNames?.length) {
            return this.tables
        }

        const names = new Set(tableNames)
        const selected = this.tables.filter(
            (table) =>
                names.has(table.sourceTable) ||
                names.has(table.targetTable) ||
                names.has(this.tableKey(table))
        )

        if (selected.length !== tableNames.length) {
            const found = new Set(
                selected.flatMap((table) => [
                    table.sourceTable,
                    table.targetTable,
                    this.tableKey(table),
                ])
            )
            const missing = tableNames.filter((name) => !found.has(name))
            throw new Error(
                `Unknown replication table(s): ${missing.join(', ')}`
            )
        }

        return selected
    }

    private skippedResult(table: NormalizedTableOptions): ReplicationResult {
        return {
            ...this.emptyResult(table),
            skipped: true,
        }
    }

    private emptyResult(table: NormalizedTableOptions): ReplicationResult {
        return {
            table: this.tableKey(table),
            sourceTable: table.sourceTable,
            targetTable: table.targetTable,
            skipped: false,
            rowsRead: 0,
            rowsWritten: 0,
        }
    }

    private tableKey(table: NormalizedTableOptions): string {
        return table.targetTable
    }

    private hasError(result: ReplicationResult[]): boolean {
        return result.some((item) => item.error)
    }

    private async safeJson<T>(request: Request): Promise<T | undefined> {
        try {
            return (await request.json()) as T
        } catch {
            return undefined
        }
    }

    private quoteIdentifier(
        identifier: string,
        dialect: 'mysql' | 'postgresql' | 'sqlite' = 'sqlite'
    ): string {
        this.validateIdentifier(identifier)
        const quote = dialect === 'mysql' ? '`' : '"'
        return `${quote}${identifier}${quote}`
    }

    private quoteQualifiedIdentifier(
        identifier: string,
        dialect: 'mysql' | 'postgresql' | 'sqlite' = 'sqlite'
    ): string {
        this.validateQualifiedIdentifier(identifier)
        return identifier
            .split('.')
            .map((part) => this.quoteIdentifier(part, dialect))
            .join('.')
    }

    private validateIdentifier(identifier: string) {
        if (!IDENTIFIER_REGEX.test(identifier)) {
            throw new Error(`Invalid SQL identifier: ${identifier}`)
        }
    }

    private validateQualifiedIdentifier(identifier: string) {
        identifier.split('.').forEach((part) => this.validateIdentifier(part))
    }

    private normalizePositiveInteger(value: number, name: string): number {
        if (!Number.isInteger(value) || value <= 0) {
            throw new Error(`${name} must be a positive integer.`)
        }

        return value
    }

    private normalizeNonNegativeInteger(value: number, name: string): number {
        if (!Number.isInteger(value) || value < 0) {
            throw new Error(`${name} must be a non-negative integer.`)
        }

        return value
    }
}

