import postgres from 'postgres'
import { StarbaseApp, StarbaseDBConfiguration } from '../../src/handler'
import { executeExternalQuery } from '../../src/operation'
import { StarbasePlugin } from '../../src/plugin'
import { DataSource } from '../../src/types'
import { createResponse } from '../../src/utils'

export interface ReplicaTableConfig {
    table: string
    schema?: string
    primaryKey?: string
    batchSize?: number
    where?: string
}

export type ReplicaExternalQueryExecutor = (opts: {
    sql: string
    params?: unknown[]
    dataSource: DataSource
    config: StarbaseDBConfiguration
}) => Promise<any>

export interface ReplicaPluginOptions {
    tables?: (string | ReplicaTableConfig)[]
    batchSize?: number
    requiresAuth?: boolean
    adminOnly?: boolean
    externalQueryExecutor?: ReplicaExternalQueryExecutor
}

export interface ReplicaTableSyncResult {
    table: string
    schema?: string
    rowsSynced: number
    pages: number
    status: 'success' | 'error'
    error?: string
}

export interface ReplicaSyncResponse {
    syncedAt: string
    results: ReplicaTableSyncResult[]
    totalRowsSynced: number
}

interface ColumnDefinition {
    name: string
    type: string
    isPrimaryKey: boolean
}

const VALID_IDENTIFIER_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/
const DEFAULT_BATCH_SIZE = 100

const CREATE_STATUS_TABLE_SQL = `
    CREATE TABLE IF NOT EXISTS tmp_replica_status (
        table_name TEXT PRIMARY KEY,
        schema_name TEXT,
        last_synced_at TEXT,
        rows_synced INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'idle',
        error_message TEXT
    )
`

export function assertValidIdentifier(name: string, label = 'identifier'): string {
    const trimmed = name.trim()
    if (!VALID_IDENTIFIER_REGEX.test(trimmed)) {
        throw new Error(`Invalid SQL ${label}: "${name}"`)
    }
    return trimmed
}

export function quoteIdentifier(name: string): string {
    return `"${assertValidIdentifier(name)}"`
}

export function mapColumnTypeToSqlite(rawType?: string): string {
    if (!rawType) return 'TEXT'
    const normalized = rawType.toLowerCase().trim()

    if (
        normalized.includes('int') ||
        normalized.includes('serial') ||
        normalized === 'bool' ||
        normalized === 'boolean'
    ) {
        return 'INTEGER'
    }

    if (
        normalized.includes('real') ||
        normalized.includes('float') ||
        normalized.includes('double') ||
        normalized.includes('numeric') ||
        normalized.includes('decimal')
    ) {
        return 'REAL'
    }

    if (
        normalized.includes('blob') ||
        normalized.includes('bytea') ||
        normalized.includes('binary')
    ) {
        return 'BLOB'
    }

    return 'TEXT'
}

export function inferColumnTypeFromValue(value: unknown): string {
    if (typeof value === 'number') {
        return Number.isInteger(value) ? 'INTEGER' : 'REAL'
    }
    if (typeof value === 'boolean') {
        return 'INTEGER'
    }
    if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
        return 'BLOB'
    }
    return 'TEXT'
}

export function normalizeSqliteValue(value: unknown): unknown {
    if (value === undefined || value === null) return null
    if (typeof value === 'boolean') return value ? 1 : 0
    if (value instanceof Date) return value.toISOString()
    if (
        typeof value === 'object' &&
        !(value instanceof Uint8Array) &&
        !(value instanceof ArrayBuffer)
    ) {
        return JSON.stringify(value)
    }
    return value
}

export function normalizeQueryRows(result: any): Record<string, unknown>[] {
    if (!result) return []

    if (Array.isArray(result)) {
        return result.filter(
            (row): row is Record<string, unknown> =>
                row !== null && typeof row === 'object' && !Array.isArray(row)
        )
    }

    if (
        Array.isArray(result.columns) &&
        Array.isArray(result.rows)
    ) {
        return result.rows.map((row: unknown[]) => {
            const obj: Record<string, unknown> = {}
            result.columns.forEach((col: string, idx: number) => {
                obj[col] = row[idx]
            })
            return obj
        })
    }

    if (Array.isArray(result.results)) {
        return normalizeQueryRows(result.results)
    }

    return []
}

export function normalizeTableConfig(
    entry: string | ReplicaTableConfig,
    defaultBatchSize: number,
    defaultSchema?: string
): Required<Pick<ReplicaTableConfig, 'table' | 'primaryKey' | 'batchSize'>> &
    Pick<ReplicaTableConfig, 'schema' | 'where'> {
    if (typeof entry === 'string') {
        return {
            table: assertValidIdentifier(entry, 'table name'),
            schema: defaultSchema
                ? assertValidIdentifier(defaultSchema, 'schema name')
                : undefined,
            primaryKey: 'id',
            batchSize: defaultBatchSize,
        }
    }

    const batchSize =
        entry.batchSize && entry.batchSize > 0
            ? Math.floor(entry.batchSize)
            : defaultBatchSize

    return {
        table: assertValidIdentifier(entry.table, 'table name'),
        schema: entry.schema
            ? assertValidIdentifier(entry.schema, 'schema name')
            : defaultSchema
              ? assertValidIdentifier(defaultSchema, 'schema name')
              : undefined,
        primaryKey: entry.primaryKey
            ? assertValidIdentifier(entry.primaryKey, 'primary key')
            : 'id',
        batchSize,
        where: entry.where,
    }
}

export class ReplicaPlugin extends StarbasePlugin {
    public readonly prefix = '/replica'
    public tables: (string | ReplicaTableConfig)[]
    public batchSize: number
    public adminOnly: boolean

    private externalQueryExecutor?: ReplicaExternalQueryExecutor

    constructor(opts: ReplicaPluginOptions = {}) {
        super('starbasedb:replica', {
            requiresAuth: opts.requiresAuth ?? true,
        })
        this.tables = opts.tables ?? []
        this.batchSize =
            opts.batchSize && opts.batchSize > 0
                ? Math.floor(opts.batchSize)
                : DEFAULT_BATCH_SIZE
        this.adminOnly = opts.adminOnly ?? true
        this.externalQueryExecutor = opts.externalQueryExecutor
    }

    override async register(app: StarbaseApp): Promise<void> {
        app.post(`${this.prefix}/sync`, async (c) => {
            const config = c.get('config')
            const dataSource = c.get('dataSource')

            if (this.adminOnly && config?.role !== 'admin') {
                return createResponse(undefined, 'Unauthorized request', 403)
            }

            if (!dataSource?.external) {
                return createResponse(
                    undefined,
                    'External data source is not configured.',
                    400
                )
            }

            let overrideTables: (string | ReplicaTableConfig)[] | undefined
            let overrideBatchSize: number | undefined

            const contentLength = c.req.header('content-length')
            const contentType = c.req.header('content-type') || ''
            if (
                contentType.includes('application/json') &&
                contentLength !== '0'
            ) {
                try {
                    const body = (await c.req.json()) as {
                        tables?: (string | ReplicaTableConfig)[]
                        batchSize?: number
                    }
                    if (Array.isArray(body?.tables)) {
                        overrideTables = body.tables
                    }
                    if (
                        typeof body?.batchSize === 'number' &&
                        body.batchSize > 0
                    ) {
                        overrideBatchSize = Math.floor(body.batchSize)
                    }
                } catch {
                    return createResponse(
                        undefined,
                        'Invalid JSON request body.',
                        400
                    )
                }
            }

            const targetTables = overrideTables ?? this.tables
            if (!targetTables.length) {
                return createResponse(
                    undefined,
                    'No tables configured for replication.',
                    400
                )
            }

            try {
                const syncResult = await this.syncTables({
                    tables: targetTables,
                    batchSize: overrideBatchSize ?? this.batchSize,
                    dataSource,
                    config,
                })
                return createResponse(syncResult, undefined, 200)
            } catch (error) {
                const message =
                    error instanceof Error
                        ? error.message
                        : 'Failed to sync replica.'
                return createResponse(undefined, message, 500)
            }
        })

        app.get(`${this.prefix}/status`, async (c) => {
            const config = c.get('config')
            const dataSource = c.get('dataSource')

            if (this.adminOnly && config?.role !== 'admin') {
                return createResponse(undefined, 'Unauthorized request', 403)
            }

            await this.ensureStatusTable(dataSource)

            const rows = await dataSource.rpc.executeQuery({
                sql: 'SELECT table_name, schema_name, last_synced_at, rows_synced, status, error_message FROM tmp_replica_status ORDER BY table_name ASC',
                params: [],
                isRaw: false,
            })

            return createResponse(
                {
                    configuredTables: this.tables.map((t) =>
                        typeof t === 'string' ? t : t.table
                    ),
                    batchSize: this.batchSize,
                    externalConfigured: Boolean(dataSource?.external),
                    tables: Array.isArray(rows) ? rows : [],
                },
                undefined,
                200
            )
        })
    }

    public async syncTables(opts: {
        tables?: (string | ReplicaTableConfig)[]
        batchSize?: number
        dataSource: DataSource
        config: StarbaseDBConfiguration
    }): Promise<ReplicaSyncResponse> {
        const { dataSource, config } = opts
        const tablesToSync = opts.tables ?? this.tables
        const effectiveBatchSize =
            opts.batchSize && opts.batchSize > 0
                ? Math.floor(opts.batchSize)
                : this.batchSize

        if (!dataSource.external) {
            throw new Error('External data source is not configured.')
        }

        await this.ensureStatusTable(dataSource)

        const results: ReplicaTableSyncResult[] = []
        let totalRowsSynced = 0

        for (const entry of tablesToSync) {
            const normalized = normalizeTableConfig(
                entry,
                effectiveBatchSize,
                dataSource.external.defaultSchema
            )

            const tableResult = await this.syncSingleTable({
                tableConfig: normalized,
                dataSource,
                config,
            })

            results.push(tableResult)
            totalRowsSynced += tableResult.rowsSynced
        }

        return {
            syncedAt: new Date().toISOString(),
            results,
            totalRowsSynced,
        }
    }

    private async ensureStatusTable(dataSource: DataSource): Promise<void> {
        await dataSource.rpc.executeQuery({
            sql: CREATE_STATUS_TABLE_SQL,
            params: [],
            isRaw: false,
        })
    }

    private async syncSingleTable(opts: {
        tableConfig: ReturnType<typeof normalizeTableConfig>
        dataSource: DataSource
        config: StarbaseDBConfiguration
    }): Promise<ReplicaTableSyncResult> {
        const { tableConfig, dataSource, config } = opts
        const { table, schema, primaryKey, batchSize, where } = tableConfig

        let rowsSynced = 0
        let pages = 0

        try {
            let columns = await this.fetchExternalSchema({
                table,
                schema,
                primaryKey,
                dataSource,
                config,
            })

            let schemaCreated = false
            if (columns.length > 0) {
                await this.createLocalTable(table, columns, dataSource)
                schemaCreated = true
            }

            let offset = 0
            while (true) {
                const selectSql = this.buildPaginatedSelectSql({
                    table,
                    schema,
                    primaryKey,
                    batchSize,
                    offset,
                    where,
                    dialect: dataSource.external?.dialect,
                    hasKnownPrimaryKey:
                        columns.length === 0 ||
                        columns.some((col) => col.name === primaryKey),
                })

                const rawRows = await this.runExternalQuery({
                    sql: selectSql,
                    params: [],
                    dataSource,
                    config,
                })

                const rows = normalizeQueryRows(rawRows)
                if (rows.length === 0) {
                    break
                }

                if (!schemaCreated) {
                    columns = this.inferColumnsFromRow(rows[0], primaryKey)
                    await this.createLocalTable(table, columns, dataSource)
                    schemaCreated = true
                }

                await this.upsertRowsIntoLocalTable(table, rows, dataSource)

                rowsSynced += rows.length
                pages += 1

                if (rows.length < batchSize) {
                    break
                }

                offset += batchSize
            }

            await this.recordTableStatus({
                dataSource,
                table,
                schema,
                rowsSynced,
                status: 'success',
                errorMessage: null,
            })

            return {
                table,
                schema,
                rowsSynced,
                pages,
                status: 'success',
            }
        } catch (error) {
            const errorMessage =
                error instanceof Error ? error.message : String(error)

            await this.recordTableStatus({
                dataSource,
                table,
                schema,
                rowsSynced,
                status: 'error',
                errorMessage,
            })

            return {
                table,
                schema,
                rowsSynced,
                pages,
                status: 'error',
                error: errorMessage,
            }
        }
    }

    private async fetchExternalSchema(opts: {
        table: string
        schema?: string
        primaryKey: string
        dataSource: DataSource
        config: StarbaseDBConfiguration
    }): Promise<ColumnDefinition[]> {
        const { table, schema, primaryKey, dataSource, config } = opts
        const dialect = dataSource.external?.dialect

        let schemaSql: string
        if (dialect === 'sqlite') {
            schemaSql = `PRAGMA table_info(${quoteIdentifier(table)})`
        } else if (dialect === 'mysql') {
            schemaSql = `SELECT COLUMN_NAME as name, DATA_TYPE as type, COLUMN_KEY as column_key FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = '${table}' ORDER BY ORDINAL_POSITION`
        } else {
            const targetSchema = schema || 'public'
            schemaSql = `SELECT column_name as name, data_type as type FROM information_schema.columns WHERE table_schema = '${targetSchema}' AND table_name = '${table}' ORDER BY ordinal_position`
        }

        try {
            const raw = await this.runExternalQuery({
                sql: schemaSql,
                params: [],
                dataSource,
                config,
            })
            const rows = normalizeQueryRows(raw)
            if (rows.length === 0) return []

            return rows
                .map((row) => {
                    const colName = String(
                        row.name ?? row.column_name ?? row.COLUMN_NAME ?? ''
                    ).trim()
                    if (!colName) return null
                    const rawType = String(
                        row.type ?? row.data_type ?? row.DATA_TYPE ?? 'TEXT'
                    )
                    const isPk =
                        Number(row.pk) === 1 ||
                        String(row.column_key ?? '').toUpperCase() === 'PRI' ||
                        colName === primaryKey
                    return {
                        name: assertValidIdentifier(colName, 'column name'),
                        type: mapColumnTypeToSqlite(rawType),
                        isPrimaryKey: isPk,
                    }
                })
                .filter((col): col is ColumnDefinition => col !== null)
        } catch {
            return []
        }
    }

    private inferColumnsFromRow(
        row: Record<string, unknown>,
        primaryKey: string
    ): ColumnDefinition[] {
        const keys = Object.keys(row)
        return keys.map((key, index) => {
            const validName = assertValidIdentifier(key, 'column name')
            const isPrimaryKey =
                validName === primaryKey ||
                (!keys.includes(primaryKey) && index === 0)
            return {
                name: validName,
                type: inferColumnTypeFromValue(row[key]),
                isPrimaryKey,
            }
        })
    }

    private async createLocalTable(
        table: string,
        columns: ColumnDefinition[],
        dataSource: DataSource
    ): Promise<void> {
        if (columns.length === 0) return

        const hasPk = columns.some((c) => c.isPrimaryKey)
        const columnDefs = columns.map((col, idx) => {
            const pkClause =
                col.isPrimaryKey || (!hasPk && idx === 0) ? ' PRIMARY KEY' : ''
            return `${quoteIdentifier(col.name)} ${col.type}${pkClause}`
        })

        const createSql = `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(table)} (${columnDefs.join(', ')})`
        await dataSource.rpc.executeQuery({
            sql: createSql,
            params: [],
            isRaw: false,
        })
    }

    private buildPaginatedSelectSql(opts: {
        table: string
        schema?: string
        primaryKey: string
        batchSize: number
        offset: number
        where?: string
        dialect?: string
        hasKnownPrimaryKey: boolean
    }): string {
        const {
            table,
            schema,
            primaryKey,
            batchSize,
            offset,
            where,
            dialect,
            hasKnownPrimaryKey,
        } = opts

        const qualifiedTable =
            schema && dialect !== 'sqlite'
                ? `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`
                : quoteIdentifier(table)

        const whereClause = where ? ` WHERE ${where}` : ''
        const orderByClause = hasKnownPrimaryKey
            ? ` ORDER BY ${quoteIdentifier(primaryKey)} ASC`
            : ''

        return `SELECT * FROM ${qualifiedTable}${whereClause}${orderByClause} LIMIT ${batchSize} OFFSET ${offset}`
    }

    private async upsertRowsIntoLocalTable(
        table: string,
        rows: Record<string, unknown>[],
        dataSource: DataSource
    ): Promise<void> {
        for (const row of rows) {
            const cols = Object.keys(row).map((k) =>
                assertValidIdentifier(k, 'column name')
            )
            if (cols.length === 0) continue

            const colList = cols.map(quoteIdentifier).join(', ')
            const placeholders = cols.map(() => '?').join(', ')
            const values = cols.map((col) => normalizeSqliteValue(row[col]))

            const insertSql = `INSERT OR REPLACE INTO ${quoteIdentifier(table)} (${colList}) VALUES (${placeholders})`
            await dataSource.rpc.executeQuery({
                sql: insertSql,
                params: values,
                isRaw: false,
            })
        }
    }

    private async recordTableStatus(opts: {
        dataSource: DataSource
        table: string
        schema?: string
        rowsSynced: number
        status: 'success' | 'error'
        errorMessage: string | null
    }): Promise<void> {
        const { dataSource, table, schema, rowsSynced, status, errorMessage } =
            opts
        await dataSource.rpc.executeQuery({
            sql: `INSERT OR REPLACE INTO tmp_replica_status (table_name, schema_name, last_synced_at, rows_synced, status, error_message) VALUES (?, ?, ?, ?, ?, ?)`,
            params: [
                table,
                schema ?? null,
                new Date().toISOString(),
                rowsSynced,
                status,
                errorMessage,
            ],
            isRaw: false,
        })
    }

    private async runExternalQuery(opts: {
        sql: string
        params?: unknown[]
        dataSource: DataSource
        config: StarbaseDBConfiguration
    }): Promise<any> {
        if (this.externalQueryExecutor) {
            return this.externalQueryExecutor(opts)
        }

        const { dataSource, sql, params, config } = opts

        if (
            dataSource.external &&
            'connectionString' in dataSource.external
        ) {
            const pgSql = postgres(dataSource.external.connectionString, {
                max: 5,
                fetch_types: false,
            })
            try {
                return await pgSql.unsafe(sql, (params ?? []) as any[])
            } finally {
                if (dataSource.executionContext) {
                    dataSource.executionContext.waitUntil(pgSql.end())
                } else {
                    await pgSql.end()
                }
            }
        }

        return executeExternalQuery({
            sql,
            params: params ?? [],
            dataSource,
            config,
        })
    }
}
