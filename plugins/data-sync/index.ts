import { StarbaseApp, StarbaseDBConfiguration } from '../../src/handler'
import { StarbasePlugin } from '../../src/plugin'
import {
    DataSource,
    ExternalDatabaseSource,
    QueryResult,
} from '../../src/types'
import { createResponse } from '../../src/utils'
import { executeExternalQuery } from '../../src/operation'

type DataSyncDialect = ExternalDatabaseSource['dialect']

export type DataSyncColumn =
    | string
    | {
          source: string
          target?: string
      }

export interface DataSyncTableConfig {
    sourceTable: string
    targetTable?: string
    cursorColumn: string
    primaryKeyColumns?: string[]
    columns?: DataSyncColumn[]
    batchSize?: number
}

export interface DataSyncRunResult {
    table: string
    targetTable: string
    rowsRead: number
    rowsWritten: number
    nextCursor: unknown
}

const SQL = {
    CREATE_CHECKPOINTS: `
        CREATE TABLE IF NOT EXISTS tmp_data_sync_checkpoints (
            source_table TEXT NOT NULL PRIMARY KEY,
            cursor_column TEXT NOT NULL,
            cursor_value TEXT,
            updated_at TEXT DEFAULT (datetime('now'))
        )
    `,
    CREATE_RUNS: `
        CREATE TABLE IF NOT EXISTS tmp_data_sync_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_table TEXT NOT NULL,
            target_table TEXT NOT NULL,
            rows_read INTEGER NOT NULL,
            rows_written INTEGER NOT NULL,
            cursor_value TEXT,
            created_at TEXT DEFAULT (datetime('now'))
        )
    `,
    READ_CHECKPOINT: `
        SELECT cursor_value
        FROM tmp_data_sync_checkpoints
        WHERE source_table = ?
        LIMIT 1
    `,
    UPSERT_CHECKPOINT: `
        INSERT INTO tmp_data_sync_checkpoints (
            source_table,
            cursor_column,
            cursor_value,
            updated_at
        )
        VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT(source_table) DO UPDATE SET
            cursor_column = excluded.cursor_column,
            cursor_value = excluded.cursor_value,
            updated_at = excluded.updated_at
    `,
    INSERT_RUN: `
        INSERT INTO tmp_data_sync_runs (
            source_table,
            target_table,
            rows_read,
            rows_written,
            cursor_value
        )
        VALUES (?, ?, ?, ?, ?)
    `,
}

function normalizeColumn(column: DataSyncColumn): {
    source: string
    target: string
} {
    if (typeof column === 'string') {
        return { source: column, target: column }
    }

    return {
        source: column.source,
        target: column.target ?? column.source,
    }
}

function assertSafeIdentifier(identifier: string): string {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
        throw new Error(`Unsafe SQL identifier: ${identifier}`)
    }

    return identifier
}

function quoteIdentifier(identifier: string, dialect: DataSyncDialect): string {
    const safe = assertSafeIdentifier(identifier)
    return dialect === 'mysql' ? `\`${safe}\`` : `"${safe}"`
}

function quoteQualifiedIdentifier(
    identifier: string,
    dialect: DataSyncDialect
): string {
    return identifier
        .split('.')
        .map((part) => quoteIdentifier(part, dialect))
        .join('.')
}

function sqliteIdentifier(identifier: string): string {
    return `"${assertSafeIdentifier(identifier)}"`
}

function defaultTargetTable(sourceTable: string): string {
    return sourceTable.split('.').map(assertSafeIdentifier).join('_')
}

function configuredColumns(config: DataSyncTableConfig): {
    source: string
    target: string
}[] {
    const columns = (config.columns ?? []).map(normalizeColumn)
    const knownTargets = new Set(columns.map((column) => column.target))

    for (const required of [
        config.cursorColumn,
        ...(config.primaryKeyColumns ?? []),
    ]) {
        if (!knownTargets.has(required)) {
            columns.push({ source: required, target: required })
            knownTargets.add(required)
        }
    }

    return columns
}

export function buildIncrementalSelect(opts: {
    config: DataSyncTableConfig
    dialect: DataSyncDialect
    cursorValue?: unknown
}): { sql: string; params: unknown[] } {
    const { config, dialect, cursorValue } = opts
    const columns =
        config.columns === undefined ? undefined : configuredColumns(config)
    const selectList =
        columns === undefined
            ? '*'
            : columns
                  .map((column) => {
                      const source = quoteIdentifier(column.source, dialect)
                      if (column.source === column.target) return source
                      return `${source} AS ${quoteIdentifier(column.target, dialect)}`
                  })
                  .join(', ')
    const cursorColumn = quoteIdentifier(config.cursorColumn, dialect)
    const where = cursorValue === undefined ? '' : `WHERE ${cursorColumn} > ?`
    const limit = Math.max(1, Math.min(config.batchSize ?? 500, 5000))

    return {
        sql: [
            `SELECT ${selectList}`,
            `FROM ${quoteQualifiedIdentifier(config.sourceTable, dialect)}`,
            where,
            `ORDER BY ${cursorColumn} ASC`,
            `LIMIT ${limit}`,
        ]
            .filter(Boolean)
            .join(' '),
        params: cursorValue === undefined ? [] : [cursorValue],
    }
}

export function buildSqliteUpsert(opts: {
    table: string
    row: QueryResult
    primaryKeyColumns?: string[]
}): { sql: string; params: unknown[] } {
    const columns = Object.keys(opts.row)
    if (columns.length === 0) {
        throw new Error('Cannot build an upsert for an empty row')
    }

    const primaryKeys = opts.primaryKeyColumns ?? []
    const insertColumns = columns.map(sqliteIdentifier).join(', ')
    const placeholders = columns.map(() => '?').join(', ')
    const base = `INSERT INTO ${sqliteIdentifier(
        opts.table
    )} (${insertColumns}) VALUES (${placeholders})`

    if (primaryKeys.length === 0) {
        return {
            sql: base,
            params: columns.map((column) => opts.row[column]),
        }
    }

    const updates = columns
        .filter((column) => !primaryKeys.includes(column))
        .map(
            (column) =>
                `${sqliteIdentifier(column)} = excluded.${sqliteIdentifier(column)}`
        )

    const conflict = ` ON CONFLICT(${primaryKeys
        .map(sqliteIdentifier)
        .join(', ')}) ${
        updates.length > 0
            ? `DO UPDATE SET ${updates.join(', ')}`
            : 'DO NOTHING'
    }`

    return {
        sql: `${base}${conflict}`,
        params: columns.map((column) => opts.row[column]),
    }
}

export function getNextCursor(
    rows: QueryResult[],
    cursorColumn: string
): unknown {
    if (rows.length === 0) return undefined
    return rows[rows.length - 1][cursorColumn]
}

export class DataSyncPlugin extends StarbasePlugin {
    public pathPrefix = '/data-sync'
    private config?: StarbaseDBConfiguration
    private dataSource?: DataSource

    constructor(private tables: DataSyncTableConfig[]) {
        super('starbasedb:data-sync', {
            requiresAuth: true,
        })
    }

    override async register(app: StarbaseApp) {
        app.use(async (c, next) => {
            this.config = c?.get('config')
            this.dataSource = c?.get('dataSource')
            await this.init()
            await next()
        })

        app.post(`${this.pathPrefix}/run`, async (c) => {
            if (this.config?.role !== 'admin') {
                return new Response('Unauthorized request', { status: 400 })
            }

            const payload = await c.req.json().catch(() => ({}))
            const tables = Array.isArray(payload?.tables)
                ? payload.tables
                : undefined
            const result = await this.runOnce(tables)

            return createResponse(result, undefined, 200)
        })
    }

    public async runOnce(
        tables: DataSyncTableConfig[] = this.tables
    ): Promise<DataSyncRunResult[]> {
        if (!this.dataSource || !this.config) {
            throw new Error(
                'DataSyncPlugin must be registered before it can run'
            )
        }

        if (!this.dataSource.external) {
            throw new Error('DataSyncPlugin requires an external data source')
        }

        await this.init()

        const results: DataSyncRunResult[] = []

        for (const table of tables) {
            const checkpoint = await this.readCheckpoint(table.sourceTable)
            const select = buildIncrementalSelect({
                config: table,
                dialect: this.dataSource.external.dialect,
                cursorValue: checkpoint,
            })
            const rows = (await executeExternalQuery({
                sql: select.sql,
                params: select.params,
                dataSource: this.dataSource,
                config: this.config,
            })) as QueryResult[]
            let rowsWritten = 0
            const targetTable =
                table.targetTable ?? defaultTargetTable(table.sourceTable)

            for (const row of rows) {
                const upsert = buildSqliteUpsert({
                    table: targetTable,
                    row,
                    primaryKeyColumns: table.primaryKeyColumns,
                })

                await this.dataSource.rpc.executeQuery({
                    sql: upsert.sql,
                    params: upsert.params,
                })
                rowsWritten += 1
            }

            const nextCursor = getNextCursor(rows, table.cursorColumn)
            if (nextCursor !== undefined) {
                await this.writeCheckpoint(
                    table.sourceTable,
                    table.cursorColumn,
                    nextCursor
                )
            }

            await this.recordRun({
                table: table.sourceTable,
                targetTable,
                rowsRead: rows.length,
                rowsWritten,
                nextCursor,
            })

            results.push({
                table: table.sourceTable,
                targetTable,
                rowsRead: rows.length,
                rowsWritten,
                nextCursor,
            })
        }

        return results
    }

    private async init() {
        if (!this.dataSource) return

        await this.dataSource.rpc.executeQuery({
            sql: SQL.CREATE_CHECKPOINTS,
            params: [],
        })
        await this.dataSource.rpc.executeQuery({
            sql: SQL.CREATE_RUNS,
            params: [],
        })
    }

    private async readCheckpoint(sourceTable: string): Promise<unknown> {
        const result = (await this.dataSource?.rpc.executeQuery({
            sql: SQL.READ_CHECKPOINT,
            params: [sourceTable],
        })) as QueryResult[]

        return result?.[0]?.cursor_value
    }

    private async writeCheckpoint(
        sourceTable: string,
        cursorColumn: string,
        cursorValue: unknown
    ) {
        await this.dataSource?.rpc.executeQuery({
            sql: SQL.UPSERT_CHECKPOINT,
            params: [sourceTable, cursorColumn, String(cursorValue)],
        })
    }

    private async recordRun(result: DataSyncRunResult) {
        await this.dataSource?.rpc.executeQuery({
            sql: SQL.INSERT_RUN,
            params: [
                result.table,
                result.targetTable,
                result.rowsRead,
                result.rowsWritten,
                result.nextCursor === undefined
                    ? null
                    : String(result.nextCursor),
            ],
        })
    }
}
