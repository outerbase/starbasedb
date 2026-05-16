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
            last_cursor_tie_breaker_value TEXT,
            last_cursor_tie_breaker_type TEXT,
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
        SELECT table_name, last_cursor_value, last_cursor_type, last_cursor_tie_breaker_value, last_cursor_tie_breaker_type, last_synced_at, total_rows_synced, last_error
        FROM tmp_starbasedb_replication_state
        WHERE table_name = ?
    `,
    SELECT_ALL_STATE: `
        SELECT table_name, last_cursor_value, last_cursor_type, last_cursor_tie_breaker_value, last_cursor_tie_breaker_type, last_synced_at, total_rows_synced, last_error
        FROM tmp_starbasedb_replication_state
        ORDER BY table_name
    `,
    UPSERT_STATE: `
        INSERT INTO tmp_starbasedb_replication_state (
            table_name, last_cursor_value, last_cursor_type, last_cursor_tie_breaker_value, last_cursor_tie_breaker_type, last_synced_at, total_rows_synced, last_error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(table_name) DO UPDATE SET
            last_cursor_value = excluded.last_cursor_value,
            last_cursor_type = excluded.last_cursor_type,
            last_cursor_tie_breaker_value = excluded.last_cursor_tie_breaker_value,
            last_cursor_tie_breaker_type = excluded.last_cursor_tie_breaker_type,
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
    cursorTieBreakerColumn?: string
    cursorTieBreakerValueType?: CursorValueType
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
    cursorTieBreakerStart?: string | null
    cursorTieBreakerEnd?: string | null
    error?: string
}

type ReplicationStateRow = QueryResult & {
    table_name: string
    last_cursor_value?: string | null
    last_cursor_type?: CursorValueType | null
    last_cursor_tie_breaker_value?: string | null
    last_cursor_tie_breaker_type?: CursorValueType | null
    last_synced_at?: string | null
    total_rows_synced?: number | string | null
    last_error?: string | null
}

type ReplicationStateBookmark = {
    cursorEnd: unknown
    cursorTieBreakerEnd: unknown
}

type InternalQuery = {
    sql: string
    params?: unknown[]
}

type InternalTransactionExecutor = {
    executeTransaction(
        queries: InternalQuery[],
        isRaw: boolean
    ): Promise<unknown[]>
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
            if (!this.dataSource || !this.config) {
                return createResponse(
                    undefined,
                    'ReplicationPlugin has not been initialized.',
                    500
                )
            }

            if (!this.isAdmin(this.config)) {
                return createResponse(undefined, 'Unauthorized request', 400)
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

            if (!this.isAdmin(this.config)) {
                return createResponse(undefined, 'Unauthorized request', 400)
            }

            const body = await this.safeJson<{ tables?: string[] }>(c.req.raw)
            const result = await this.sync({
                dataSource: this.dataSource,
                config: this.config,
                force: true,
                tableNames: body?.tables,
            })

            return createResponse(
                result,
                undefined,
                this.hasError(result) ? 500 : 200
            )
        })

        app.post(`${this.pathPrefix}/pull/:tableName`, async (c) => {
            if (!this.dataSource || !this.config) {
                return createResponse(
                    undefined,
                    'ReplicationPlugin has not been initialized.',
                    500
                )
            }

            if (!this.isAdmin(this.config)) {
                return createResponse(undefined, 'Unauthorized request', 400)
            }

            const tableName = c.req.param('tableName')
            const result = await this.sync({
                dataSource: this.dataSource,
                config: this.config,
                force: true,
                tableNames: [tableName],
            })

            return createResponse(
                result,
                undefined,
                this.hasError(result) ? 500 : 200
            )
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
        const bookmark = this.findStateBookmark(table, rows, state)

        const result: ReplicationResult = {
            table: this.tableKey(table),
            sourceTable: table.sourceTable,
            targetTable: table.targetTable,
            skipped: false,
            rowsRead: rows.length,
            rowsWritten: transformedRows.length,
            cursorStart: state?.last_cursor_value ?? null,
            cursorEnd:
                bookmark.cursorEnd == null ? null : String(bookmark.cursorEnd),
            cursorTieBreakerStart: state?.last_cursor_tie_breaker_value ?? null,
            cursorTieBreakerEnd:
                bookmark.cursorTieBreakerEnd == null
                    ? null
                    : String(bookmark.cursorTieBreakerEnd),
        }

        const writeQueries: InternalQuery[] = transformedRows.map((row) =>
            this.buildInsertQuery(table, row)
        )
        writeQueries.push(
            this.buildUpsertStateQuery({
                table,
                state,
                bookmark,
                rowsWritten: transformedRows.length,
            })
        )
        writeQueries.push(
            this.buildRecordRunQuery(table, {
                ...result,
                startedAt,
                finishedAt: new Date().toISOString(),
            })
        )

        await this.executeInternalTransaction(dataSource, writeQueries)

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
            await this.addStateColumnIfMissing(
                dataSource,
                'last_cursor_tie_breaker_value TEXT'
            )
            await this.addStateColumnIfMissing(
                dataSource,
                'last_cursor_tie_breaker_type TEXT'
            )
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

    private async addStateColumnIfMissing(
        dataSource: DataSource,
        columnDefinition: string
    ) {
        try {
            await dataSource.rpc.executeQuery({
                sql: `ALTER TABLE tmp_starbasedb_replication_state ADD COLUMN ${columnDefinition}`,
                params: [],
            })
        } catch (error) {
            const message =
                error instanceof Error ? error.message : String(error)

            if (!/duplicate column|already exists/i.test(message)) {
                throw error
            }
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
            ? table.columns
                  .map((column) => this.quoteIdentifier(column, quoteStyle))
                  .join(', ')
            : '*'
        const conditions: string[] = []
        const params: unknown[] = []

        if (table.where) {
            conditions.push(`(${table.where})`)
        }

        if (table.cursorColumn && state?.last_cursor_value != null) {
            const cursorIdentifier = this.quoteIdentifier(
                table.cursorColumn,
                quoteStyle
            )
            const cursorValue = this.deserializeCursorValue(state)

            if (
                this.usesCursorTieBreaker(table) &&
                state.last_cursor_tie_breaker_value != null
            ) {
                const tieBreakerIdentifier = this.quoteIdentifier(
                    table.cursorTieBreakerColumn as string,
                    quoteStyle
                )
                conditions.push(
                    `(${cursorIdentifier} > ? OR (${cursorIdentifier} = ? AND ${tieBreakerIdentifier} > ?))`
                )
                params.push(
                    cursorValue,
                    cursorValue,
                    this.deserializeCursorTieBreakerValue(state)
                )
            } else {
                conditions.push(`${cursorIdentifier} > ?`)
                params.push(cursorValue)
            }
        }

        const where = conditions.length
            ? ` WHERE ${conditions.join(' AND ')}`
            : ''
        const orderByParts: string[] = []
        if (table.cursorColumn) {
            orderByParts.push(
                this.quoteIdentifier(table.cursorColumn, quoteStyle)
            )

            if (this.usesCursorTieBreaker(table)) {
                orderByParts.push(
                    this.quoteIdentifier(
                        table.cursorTieBreakerColumn as string,
                        quoteStyle
                    )
                )
            }
        }
        const orderBy = orderByParts.length
            ? ` ORDER BY ${orderByParts
                  .map((identifier) => `${identifier} ASC`)
                  .join(', ')}`
            : ''
        const limit = table.cursorColumn ? ` LIMIT ${table.batchSize}` : ''

        return {
            sql: `SELECT ${columns} FROM ${this.quoteQualifiedIdentifier(
                table.sourceTable,
                quoteStyle
            )}${where}${orderBy}${limit}`,
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

    private findStateBookmark(
        table: NormalizedTableOptions,
        rows: Record<string, unknown>[],
        state?: ReplicationStateRow
    ): ReplicationStateBookmark {
        if (!table.cursorColumn || rows.length === 0) {
            return {
                cursorEnd: state?.last_cursor_value ?? null,
                cursorTieBreakerEnd:
                    state?.last_cursor_tie_breaker_value ?? null,
            }
        }

        const cursorColumn = table.cursorColumn
        const tieBreakerColumn = this.usesCursorTieBreaker(table)
            ? table.cursorTieBreakerColumn
            : undefined
        const cursorRows = rows.filter(
            (row) =>
                row[cursorColumn] !== undefined &&
                row[cursorColumn] !== null &&
                (!tieBreakerColumn ||
                    (row[tieBreakerColumn] !== undefined &&
                        row[tieBreakerColumn] !== null))
        )

        if (!cursorRows.length) {
            return {
                cursorEnd: state?.last_cursor_value ?? null,
                cursorTieBreakerEnd:
                    state?.last_cursor_tie_breaker_value ?? null,
            }
        }

        const lastRow = cursorRows.reduce((maxRow, row) =>
            this.compareCursorRows(table, row, maxRow) > 0 ? row : maxRow
        )

        return {
            cursorEnd: lastRow[cursorColumn],
            cursorTieBreakerEnd: tieBreakerColumn
                ? lastRow[tieBreakerColumn]
                : null,
        }
    }

    private compareCursorRows(
        table: NormalizedTableOptions,
        left: Record<string, unknown>,
        right: Record<string, unknown>
    ): number {
        if (!table.cursorColumn) {
            return 0
        }

        const cursorCompare = this.compareCursorValues(
            left[table.cursorColumn],
            right[table.cursorColumn],
            table.cursorValueType
        )

        if (cursorCompare !== 0 || !this.usesCursorTieBreaker(table)) {
            return cursorCompare
        }

        const tieBreakerColumn = table.cursorTieBreakerColumn as string
        return this.compareCursorValues(
            left[tieBreakerColumn],
            right[tieBreakerColumn],
            table.cursorTieBreakerValueType
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

    private deserializeCursorTieBreakerValue(
        state: ReplicationStateRow
    ): unknown {
        if (state.last_cursor_tie_breaker_type === 'number') {
            return Number(state.last_cursor_tie_breaker_value)
        }

        return state.last_cursor_tie_breaker_value
    }

    private cursorTypeForValue(
        value: unknown,
        configuredType?: CursorValueType
    ): CursorValueType | null {
        if (value == null) {
            return configuredType ?? null
        }

        if (configuredType) {
            return configuredType
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
        })) as unknown as ReplicationStateRow[]

        return rows[0]
    }

    private async readAllState(dataSource: DataSource) {
        return (await dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.SELECT_ALL_STATE,
            params: [],
        })) as unknown as ReplicationStateRow[]
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

    private buildUpsertStateQuery(opts: {
        table: NormalizedTableOptions
        state?: ReplicationStateRow
        bookmark: ReplicationStateBookmark
        rowsWritten: number
    }): InternalQuery {
        const { table, state, bookmark, rowsWritten } = opts
        const totalRowsSynced =
            Number(state?.total_rows_synced ?? 0) + rowsWritten
        const cursorType = this.cursorTypeForValue(
            bookmark.cursorEnd,
            table.cursorValueType
        )
        const tieBreakerType = this.cursorTypeForValue(
            bookmark.cursorTieBreakerEnd,
            table.cursorTieBreakerValueType
        )

        return {
            sql: SQL_QUERIES.UPSERT_STATE,
            params: [
                this.tableKey(table),
                bookmark.cursorEnd == null ? null : String(bookmark.cursorEnd),
                cursorType,
                bookmark.cursorTieBreakerEnd == null
                    ? null
                    : String(bookmark.cursorTieBreakerEnd),
                tieBreakerType,
                new Date().toISOString(),
                totalRowsSynced,
            ],
        }
    }

    private buildRecordRunQuery(
        table: NormalizedTableOptions,
        result: ReplicationResult & { startedAt: string; finishedAt: string }
    ): InternalQuery {
        return {
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
        }
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
        if (table.cursorTieBreakerColumn) {
            this.validateIdentifier(table.cursorTieBreakerColumn)
        }

        const primaryKey = Array.isArray(table.primaryKey)
            ? table.primaryKey
            : table.primaryKey
              ? [table.primaryKey]
              : []
        primaryKey.forEach((column) => this.validateIdentifier(column))
        const cursorTieBreakerColumn = table.cursorColumn
            ? (table.cursorTieBreakerColumn ?? primaryKey[0])
            : undefined

        if (table.cursorColumn && !cursorTieBreakerColumn) {
            throw new Error(
                `Replication table ${table.sourceTable} requires primaryKey or cursorTieBreakerColumn when cursorColumn is configured.`
            )
        }

        if (table.columns?.length && table.cursorColumn) {
            this.requireSelectedColumn(table, table.cursorColumn)

            if (cursorTieBreakerColumn) {
                this.requireSelectedColumn(table, cursorTieBreakerColumn)
            }
        }

        return {
            ...table,
            sourceTable: table.sourceTable,
            targetTable,
            cursorTieBreakerColumn,
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

    private usesCursorTieBreaker(table: NormalizedTableOptions): boolean {
        return Boolean(
            table.cursorColumn &&
                table.cursorTieBreakerColumn &&
                table.cursorTieBreakerColumn !== table.cursorColumn
        )
    }

    private async executeInternalTransaction(
        dataSource: DataSource,
        queries: InternalQuery[]
    ) {
        await (
            dataSource.rpc as unknown as InternalTransactionExecutor
        ).executeTransaction(queries, false)
    }

    private hasError(result: ReplicationResult[]): boolean {
        return result.some((item) => item.error)
    }

    private isAdmin(config: StarbaseDBConfiguration): boolean {
        return config.role === 'admin'
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

    private requireSelectedColumn(
        table: ReplicationTableOptions,
        column: string
    ) {
        if (!table.columns?.includes(column)) {
            throw new Error(
                `Replication table ${table.sourceTable} columns must include ${column}.`
            )
        }
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
