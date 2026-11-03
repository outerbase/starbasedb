import { StarbaseApp, StarbaseDBConfiguration } from '../../src/handler'
import { executeExternalQuery } from '../../src/operation'
import { StarbasePlugin } from '../../src/plugin'
import { DataSource } from '../../src/types'
import { createResponse } from '../../src/utils'

export type SqliteColumnType = 'INTEGER' | 'REAL' | 'TEXT' | 'BLOB'

export interface ColumnDefinition {
    name: string
    type: string
    sqliteType: SqliteColumnType
    nullable: boolean
    isPrimaryKey: boolean
}

export interface TableSyncConfig {
    table: string
    schema?: string
    trackingColumn?: string
    primaryKey?: string
    batchSize?: number
}

export interface NormalizedTableSyncConfig {
    sourceSchema: string
    sourceTable: string
    internalTable: string
    trackingColumn?: string
    primaryKey?: string
    batchSize: number
}

export interface DataSyncOptions {
    sync_interval?: number
    syncInterval?: number
    batch_size?: number
    batchSize?: number
    tables?: Array<string | TableSyncConfig>
    source?: DatabaseSyncSource
    autoSyncOnRequest?: boolean
}

export interface TableSyncMetadata {
    table_name: string
    source_schema: string
    source_table: string
    tracking_column: string | null
    last_sync_timestamp: number
    last_sync_value: string | null
    rows_synced: number
    status: string
    last_error: string | null
}

const SQL_QUERIES = {
    CREATE_METADATA_TABLE: `
        CREATE TABLE IF NOT EXISTS tmp_data_sync_metadata (
            table_name TEXT PRIMARY KEY,
            source_schema TEXT NOT NULL,
            source_table TEXT NOT NULL,
            tracking_column TEXT,
            last_sync_timestamp INTEGER NOT NULL DEFAULT 0,
            last_sync_value TEXT,
            rows_synced INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'idle',
            last_error TEXT
        )
    `,
    CREATE_ERRORS_TABLE: `
        CREATE TABLE IF NOT EXISTS tmp_data_sync_errors (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            table_name TEXT NOT NULL,
            error_message TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `,
    GET_ALL_METADATA: `
        SELECT
            table_name,
            source_schema,
            source_table,
            tracking_column,
            last_sync_timestamp,
            last_sync_value,
            rows_synced,
            status,
            last_error
        FROM tmp_data_sync_metadata
    `,
    GET_TABLE_METADATA: `
        SELECT
            table_name,
            source_schema,
            source_table,
            tracking_column,
            last_sync_timestamp,
            last_sync_value,
            rows_synced,
            status,
            last_error
        FROM tmp_data_sync_metadata
        WHERE table_name = ?
    `,
    UPSERT_METADATA: `
        INSERT OR REPLACE INTO tmp_data_sync_metadata (
            table_name,
            source_schema,
            source_table,
            tracking_column,
            last_sync_timestamp,
            last_sync_value,
            rows_synced,
            status,
            last_error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    INSERT_ERROR: `
        INSERT INTO tmp_data_sync_errors (table_name, error_message)
        VALUES (?, ?)
    `,
    GET_RECENT_ERRORS: `
        SELECT id, table_name, error_message, created_at
        FROM tmp_data_sync_errors
        ORDER BY id DESC
        LIMIT 20
    `,
}

export function quoteSqlIdentifier(identifier: string): string {
    if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) {
        return identifier
    }
    return `"${identifier.replace(/"/g, '""')}"`
}

export function normalizeExternalRows(rawResult: any): Record<string, any>[] {
    if (!rawResult) {
        return []
    }
    if (Array.isArray(rawResult)) {
        return rawResult
    }
    if (Array.isArray(rawResult.rows) && Array.isArray(rawResult.columns)) {
        return rawResult.rows.map((row: any) => {
            if (row && typeof row === 'object' && !Array.isArray(row)) {
                return row
            }
            return rawResult.columns.reduce(
                (acc: Record<string, any>, col: string, idx: number) => {
                    acc[col] = row?.[idx]
                    return acc
                },
                {}
            )
        })
    }
    if (Array.isArray(rawResult.rows)) {
        return rawResult.rows
    }
    if (Array.isArray(rawResult.items)) {
        return rawResult.items
    }
    return []
}

export function serializeSqliteValue(value: unknown): unknown {
    if (value === undefined || value === null) {
        return null
    }
    if (typeof value === 'boolean') {
        return value ? 1 : 0
    }
    if (value instanceof Date) {
        return value.toISOString()
    }
    if (
        typeof value === 'object' &&
        !(value instanceof Uint8Array) &&
        !(value instanceof ArrayBuffer)
    ) {
        return JSON.stringify(value)
    }
    return value
}

export abstract class DatabaseSyncSource {
    public readonly dialect: 'postgresql' | 'mysql' | 'sqlite'
    public readonly defaultSchema: string

    constructor(opts: {
        dialect: 'postgresql' | 'mysql' | 'sqlite'
        defaultSchema?: string
    }) {
        this.dialect = opts.dialect
        this.defaultSchema =
            opts.defaultSchema ||
            (opts.dialect === 'postgresql'
                ? 'public'
                : opts.dialect === 'mysql'
                  ? 'public'
                  : 'main')
    }

    public abstract mapColumnType(externalType: string): SqliteColumnType

    public abstract getTableSchemaQuery(
        schema: string,
        table: string
    ): { sql: string; params: any[] }

    public abstract parseSchemaRows(
        rows: Record<string, any>[],
        primaryKeyOverride?: string
    ): ColumnDefinition[]

    public abstract getFetchRecordsQuery(opts: {
        schema: string
        table: string
        trackingColumn?: string
        lastValue?: string | number | null
        batchSize: number
        offset: number
    }): { sql: string; params: any[] }

    public parseTableIdentifier(
        rawTable: string,
        explicitSchema?: string
    ): {
        sourceSchema: string
        sourceTable: string
        internalTable: string
    } {
        const trimmed = rawTable.trim()
        let sourceSchema = explicitSchema?.trim() || this.defaultSchema
        let sourceTable = trimmed

        if (!explicitSchema && trimmed.includes('.')) {
            const parts = trimmed.split('.')
            sourceSchema = parts[0].trim() || this.defaultSchema
            sourceTable = parts.slice(1).join('_').trim()
        }

        const isDefaultSchema =
            !sourceSchema ||
            sourceSchema.toLowerCase() === this.defaultSchema.toLowerCase() ||
            sourceSchema.toLowerCase() === 'public' ||
            sourceSchema.toLowerCase() === 'main'

        const internalTable = isDefaultSchema
            ? sourceTable
            : `${sourceSchema}_${sourceTable}`

        return {
            sourceSchema,
            sourceTable,
            internalTable,
        }
    }
}

export class PostgresSyncSource extends DatabaseSyncSource {
    constructor(opts?: { dialect?: 'postgresql'; defaultSchema?: string }) {
        super({
            dialect: 'postgresql',
            defaultSchema: opts?.defaultSchema || 'public',
        })
    }

    public override mapColumnType(externalType: string): SqliteColumnType {
        const normalized = (externalType || '').toLowerCase().trim()

        if (
            normalized.includes('int') ||
            normalized === 'serial' ||
            normalized === 'bigserial' ||
            normalized === 'smallserial' ||
            normalized === 'boolean' ||
            normalized === 'bool'
        ) {
            return 'INTEGER'
        }

        if (
            normalized.includes('real') ||
            normalized.includes('float') ||
            normalized.includes('double') ||
            normalized.includes('numeric') ||
            normalized.includes('decimal') ||
            normalized === 'money'
        ) {
            return 'REAL'
        }

        if (normalized === 'bytea') {
            return 'BLOB'
        }

        return 'TEXT'
    }

    public override getTableSchemaQuery(
        schema: string,
        table: string
    ): { sql: string; params: any[] } {
        const escapedSchema = schema.replace(/'/g, "''")
        const escapedTable = table.replace(/'/g, "''")
        const sql = `
            SELECT
                c.column_name AS column_name,
                c.data_type AS data_type,
                c.is_nullable AS is_nullable,
                CASE WHEN pk.column_name IS NOT NULL THEN 1 ELSE 0 END AS is_primary_key
            FROM information_schema.columns c
            LEFT JOIN (
                SELECT kcu.table_schema, kcu.table_name, kcu.column_name
                FROM information_schema.table_constraints tc
                JOIN information_schema.key_column_usage kcu
                    ON tc.constraint_name = kcu.constraint_name
                    AND tc.table_schema = kcu.table_schema
                WHERE tc.constraint_type = 'PRIMARY KEY'
            ) pk
                ON c.table_schema = pk.table_schema
                AND c.table_name = pk.table_name
                AND c.column_name = pk.column_name
            WHERE c.table_schema = '${escapedSchema}'
              AND c.table_name = '${escapedTable}'
            ORDER BY c.ordinal_position ASC
        `
        return { sql: sql.trim(), params: [] }
    }

    public override parseSchemaRows(
        rows: Record<string, any>[],
        primaryKeyOverride?: string
    ): ColumnDefinition[] {
        return rows.map((row) => {
            const name = String(
                row.column_name ?? row.COLUMN_NAME ?? row.name ?? ''
            )
            const rawType = String(
                row.data_type ?? row.DATA_TYPE ?? row.type ?? 'text'
            )
            const nullableRaw =
                row.is_nullable ?? row.IS_NULLABLE ?? row.nullable ?? 'YES'
            const isNullable =
                typeof nullableRaw === 'boolean'
                    ? nullableRaw
                    : String(nullableRaw).toUpperCase() !== 'NO'

            const isPkFromRow =
                Boolean(row.is_primary_key) &&
                row.is_primary_key !== 0 &&
                row.is_primary_key !== '0' &&
                row.is_primary_key !== 'false'

            const isPrimaryKey = primaryKeyOverride
                ? name === primaryKeyOverride
                : isPkFromRow

            return {
                name,
                type: rawType,
                sqliteType: this.mapColumnType(rawType),
                nullable: isNullable,
                isPrimaryKey,
            }
        })
    }

    public override getFetchRecordsQuery(opts: {
        schema: string
        table: string
        trackingColumn?: string
        lastValue?: string | number | null
        batchSize: number
        offset: number
    }): { sql: string; params: any[] } {
        const quotedSchema = quoteSqlIdentifier(opts.schema || 'public')
        const quotedTable = quoteSqlIdentifier(opts.table)
        const fullTable =
            !opts.schema || opts.schema === 'public'
                ? quotedTable
                : `${quotedSchema}.${quotedTable}`

        if (opts.trackingColumn) {
            const quotedCol = quoteSqlIdentifier(opts.trackingColumn)
            if (opts.lastValue !== undefined && opts.lastValue !== null) {
                const literal =
                    typeof opts.lastValue === 'number'
                        ? String(opts.lastValue)
                        : `'${String(opts.lastValue).replace(/'/g, "''")}'`
                return {
                    sql: `SELECT * FROM ${fullTable} WHERE ${quotedCol} > ${literal} ORDER BY ${quotedCol} ASC LIMIT ${opts.batchSize} OFFSET ${opts.offset}`,
                    params: [],
                }
            }
            return {
                sql: `SELECT * FROM ${fullTable} ORDER BY ${quotedCol} ASC LIMIT ${opts.batchSize} OFFSET ${opts.offset}`,
                params: [],
            }
        }

        return {
            sql: `SELECT * FROM ${fullTable} LIMIT ${opts.batchSize} OFFSET ${opts.offset}`,
            params: [],
        }
    }
}

export class MySQLSyncSource extends DatabaseSyncSource {
    constructor(opts?: { dialect?: 'mysql'; defaultSchema?: string }) {
        super({
            dialect: 'mysql',
            defaultSchema: opts?.defaultSchema || 'public',
        })
    }

    public override mapColumnType(externalType: string): SqliteColumnType {
        const normalized = (externalType || '').toLowerCase().trim()

        if (
            normalized.includes('int') ||
            normalized === 'bit' ||
            normalized === 'boolean' ||
            normalized === 'bool'
        ) {
            return 'INTEGER'
        }

        if (
            normalized.includes('float') ||
            normalized.includes('double') ||
            normalized.includes('decimal') ||
            normalized.includes('numeric')
        ) {
            return 'REAL'
        }

        if (normalized.includes('blob') || normalized.includes('binary')) {
            return 'BLOB'
        }

        return 'TEXT'
    }

    public override getTableSchemaQuery(
        schema: string,
        table: string
    ): { sql: string; params: any[] } {
        const escapedTable = table.replace(/'/g, "''")
        const schemaFilter =
            schema && schema !== 'public'
                ? `TABLE_SCHEMA = '${schema.replace(/'/g, "''")}'`
                : 'TABLE_SCHEMA = DATABASE()'

        const sql = `
            SELECT
                COLUMN_NAME AS column_name,
                DATA_TYPE AS data_type,
                IS_NULLABLE AS is_nullable,
                CASE WHEN COLUMN_KEY = 'PRI' THEN 1 ELSE 0 END AS is_primary_key
            FROM information_schema.columns
            WHERE ${schemaFilter}
              AND TABLE_NAME = '${escapedTable}'
            ORDER BY ORDINAL_POSITION ASC
        `
        return { sql: sql.trim(), params: [] }
    }

    public override parseSchemaRows(
        rows: Record<string, any>[],
        primaryKeyOverride?: string
    ): ColumnDefinition[] {
        return rows.map((row) => {
            const name = String(
                row.column_name ?? row.COLUMN_NAME ?? row.name ?? ''
            )
            const rawType = String(
                row.data_type ?? row.DATA_TYPE ?? row.type ?? 'text'
            )
            const nullableRaw =
                row.is_nullable ?? row.IS_NULLABLE ?? row.nullable ?? 'YES'
            const isNullable =
                typeof nullableRaw === 'boolean'
                    ? nullableRaw
                    : String(nullableRaw).toUpperCase() !== 'NO'

            const isPkFromRow =
                Boolean(row.is_primary_key) &&
                row.is_primary_key !== 0 &&
                row.is_primary_key !== '0' &&
                row.is_primary_key !== 'false'

            return {
                name,
                type: rawType,
                sqliteType: this.mapColumnType(rawType),
                nullable: isNullable,
                isPrimaryKey: primaryKeyOverride
                    ? name === primaryKeyOverride
                    : isPkFromRow,
            }
        })
    }

    public override getFetchRecordsQuery(opts: {
        schema: string
        table: string
        trackingColumn?: string
        lastValue?: string | number | null
        batchSize: number
        offset: number
    }): { sql: string; params: any[] } {
        const quotedTable = quoteSqlIdentifier(opts.table)
        const fullTable =
            !opts.schema || opts.schema === 'public'
                ? quotedTable
                : `${quoteSqlIdentifier(opts.schema)}.${quotedTable}`

        if (opts.trackingColumn) {
            const quotedCol = quoteSqlIdentifier(opts.trackingColumn)
            if (opts.lastValue !== undefined && opts.lastValue !== null) {
                const literal =
                    typeof opts.lastValue === 'number'
                        ? String(opts.lastValue)
                        : `'${String(opts.lastValue).replace(/'/g, "''")}'`
                return {
                    sql: `SELECT * FROM ${fullTable} WHERE ${quotedCol} > ${literal} ORDER BY ${quotedCol} ASC LIMIT ${opts.batchSize} OFFSET ${opts.offset}`,
                    params: [],
                }
            }
            return {
                sql: `SELECT * FROM ${fullTable} ORDER BY ${quotedCol} ASC LIMIT ${opts.batchSize} OFFSET ${opts.offset}`,
                params: [],
            }
        }

        return {
            sql: `SELECT * FROM ${fullTable} LIMIT ${opts.batchSize} OFFSET ${opts.offset}`,
            params: [],
        }
    }
}

export class DataSyncPlugin extends StarbasePlugin {
    public override pathPrefix: string = '/data-sync'
    private syncSource: DatabaseSyncSource
    private syncIntervalMs: number
    private defaultBatchSize: number
    private rawTables: Array<string | TableSyncConfig>
    private autoSyncOnRequest: boolean
    private dataSource?: DataSource
    private config?: StarbaseDBConfiguration
    private initializedTables: boolean = false

    constructor(
        sourceOrOpts?: DatabaseSyncSource | DataSyncOptions,
        maybeOpts?: DataSyncOptions
    ) {
        super(
            'starbasedb:data-sync',
            {
                requiresAuth: true,
            },
            '/data-sync'
        )

        let resolvedSource: DatabaseSyncSource | undefined
        let resolvedOpts: DataSyncOptions = {}

        if (sourceOrOpts instanceof DatabaseSyncSource) {
            resolvedSource = sourceOrOpts
            resolvedOpts = maybeOpts || {}
        } else if (sourceOrOpts && typeof sourceOrOpts === 'object') {
            resolvedOpts = sourceOrOpts
            resolvedSource = sourceOrOpts.source
        }

        this.syncSource = resolvedSource || new PostgresSyncSource()
        const intervalSeconds =
            resolvedOpts.sync_interval ?? resolvedOpts.syncInterval ?? 300
        this.syncIntervalMs = Math.max(1, intervalSeconds) * 1000
        this.defaultBatchSize =
            resolvedOpts.batch_size ?? resolvedOpts.batchSize ?? 500
        this.rawTables = resolvedOpts.tables || []
        this.autoSyncOnRequest = resolvedOpts.autoSyncOnRequest ?? true
    }

    public getNormalizedTables(): NormalizedTableSyncConfig[] {
        return this.rawTables.map((entry) => {
            if (typeof entry === 'string') {
                const parsed = this.syncSource.parseTableIdentifier(entry)
                return {
                    ...parsed,
                    batchSize: this.defaultBatchSize,
                }
            }
            const parsed = this.syncSource.parseTableIdentifier(
                entry.table,
                entry.schema
            )
            return {
                ...parsed,
                trackingColumn: entry.trackingColumn,
                primaryKey: entry.primaryKey,
                batchSize: entry.batchSize ?? this.defaultBatchSize,
            }
        })
    }

    override async register(app: StarbaseApp): Promise<void> {
        app.use('*', async (c, next) => {
            this.dataSource = c?.get('dataSource')
            this.config = c?.get('config')
            await this.ensureMetadataTables()

            if (this.autoSyncOnRequest && this.dataSource) {
                const syncPromise = this.syncDueTables()
                if (this.dataSource.executionContext?.waitUntil) {
                    this.dataSource.executionContext.waitUntil(syncPromise)
                } else {
                    await syncPromise
                }
            }

            await next()
        })

        app.get(`${this.pathPrefix}/status`, async () => {
            if (this.config && this.config.role !== 'admin') {
                return createResponse(undefined, 'Unauthorized request', 403)
            }
            const status = await this.getSyncStatus()
            return createResponse(status, undefined, 200)
        })

        const handleManualSync = async (c: any) => {
            if (this.config && this.config.role !== 'admin') {
                return createResponse(undefined, 'Unauthorized request', 403)
            }

            let targetTable: string | undefined
            try {
                const body = await c.req.json()
                if (body && typeof body.table === 'string') {
                    targetTable = body.table
                }
            } catch {
                // Empty body is valid; syncs all configured tables
            }

            const results = await this.syncAllTables(targetTable)
            return createResponse({ results }, undefined, 200)
        }

        app.post(`${this.pathPrefix}/trigger`, handleManualSync)
        app.post(`${this.pathPrefix}/sync`, handleManualSync)
    }

    override async beforeQuery(opts: {
        sql: string
        params?: unknown[]
        dataSource?: DataSource
        config?: StarbaseDBConfiguration
    }): Promise<{ sql: string; params?: unknown[] }> {
        let { sql, params, dataSource } = opts
        const activeSource = dataSource?.source ?? this.dataSource?.source

        // Only rewrite schema-qualified table names when querying the internal SQLite replica
        if (activeSource && activeSource !== 'internal') {
            return { sql, params }
        }

        // 1. Rewrite configured non-default schema references (e.g. `analytics.events` -> `analytics_events`)
        for (const tableCfg of this.getNormalizedTables()) {
            if (
                tableCfg.sourceSchema &&
                tableCfg.sourceSchema.toLowerCase() !== 'public' &&
                tableCfg.sourceSchema.toLowerCase() !== 'main'
            ) {
                const pattern = new RegExp(
                    `(?:"${this.escapeRegExp(tableCfg.sourceSchema)}"|\\b${this.escapeRegExp(tableCfg.sourceSchema)})\\.(?:"${this.escapeRegExp(tableCfg.sourceTable)}"|${this.escapeRegExp(tableCfg.sourceTable)}\\b)`,
                    'gi'
                )
                sql = sql.replace(pattern, tableCfg.internalTable)
            }
        }

        // 2. Strip `public.` prefix (e.g. `SELECT * FROM public.users` or `"public"."users"` -> `users`)
        sql = sql.replace(
            /(?:"public"|\bpublic)\.(?:"([a-zA-Z_][a-zA-Z0-9_]*)"|([a-zA-Z_][a-zA-Z0-9_]*)\b)/gi,
            (_match, quotedName, unquotedName) =>
                quotedName ? `"${quotedName}"` : unquotedName
        )

        return { sql, params }
    }

    private escapeRegExp(value: string): string {
        return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }

    public async ensureMetadataTables(): Promise<void> {
        if (!this.dataSource || this.initializedTables) {
            return
        }

        await this.dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.CREATE_METADATA_TABLE,
            params: [],
        })
        await this.dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.CREATE_ERRORS_TABLE,
            params: [],
        })
        this.initializedTables = true
    }

    public async getSyncStatus(): Promise<{
        tables: TableSyncMetadata[]
        errors: Record<string, any>[]
    }> {
        if (!this.dataSource) {
            return { tables: [], errors: [] }
        }
        await this.ensureMetadataTables()

        const tables = ((await this.dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.GET_ALL_METADATA,
            params: [],
        })) || []) as TableSyncMetadata[]

        const errors = ((await this.dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.GET_RECENT_ERRORS,
            params: [],
        })) || []) as Record<string, any>[]

        return { tables, errors }
    }

    public async syncDueTables(): Promise<void> {
        if (!this.dataSource || !this.dataSource.external) {
            return
        }

        const now = Date.now()
        for (const tableCfg of this.getNormalizedTables()) {
            const metaRows = ((await this.dataSource.rpc.executeQuery({
                sql: SQL_QUERIES.GET_TABLE_METADATA,
                params: [tableCfg.internalTable],
            })) || []) as TableSyncMetadata[]

            const lastSync = metaRows[0]?.last_sync_timestamp ?? 0
            if (now - lastSync >= this.syncIntervalMs) {
                await this.syncTable(tableCfg)
            }
        }
    }

    public async syncAllTables(
        onlyTable?: string
    ): Promise<Array<{ table: string; rowsSynced: number; status: string; error?: string }>> {
        const results: Array<{
            table: string
            rowsSynced: number
            status: string
            error?: string
        }> = []

        const tables = this.getNormalizedTables().filter((t) =>
            onlyTable
                ? t.internalTable === onlyTable ||
                  t.sourceTable === onlyTable ||
                  `${t.sourceSchema}.${t.sourceTable}` === onlyTable
                : true
        )

        for (const tableCfg of tables) {
            const res = await this.syncTable(tableCfg)
            results.push(res)
        }

        return results
    }

    public async syncTable(
        tableCfg: NormalizedTableSyncConfig
    ): Promise<{ table: string; rowsSynced: number; status: string; error?: string }> {
        if (!this.dataSource) {
            return {
                table: tableCfg.internalTable,
                rowsSynced: 0,
                status: 'skipped',
                error: 'No dataSource configured',
            }
        }

        await this.ensureMetadataTables()

        const existingMetaRows = ((await this.dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.GET_TABLE_METADATA,
            params: [tableCfg.internalTable],
        })) || []) as TableSyncMetadata[]

        const existingMeta = existingMetaRows[0]
        let lastSyncValue: string | number | null =
            existingMeta?.last_sync_value ?? null
        let totalRowsSynced = Number(existingMeta?.rows_synced ?? 0)

        try {
            // 1. Introspect external table schema
            const schemaQuery = this.syncSource.getTableSchemaQuery(
                tableCfg.sourceSchema,
                tableCfg.sourceTable
            )
            const rawSchemaResult = await executeExternalQuery({
                sql: schemaQuery.sql,
                params: schemaQuery.params,
                dataSource: this.dataSource,
                config: this.config || { role: 'admin' },
            })
            const schemaRows = normalizeExternalRows(rawSchemaResult)
            let columns = this.syncSource.parseSchemaRows(
                schemaRows,
                tableCfg.primaryKey
            )

            // 2. Determine tracking column for incremental checkpointing
            let trackingColumn = tableCfg.trackingColumn
            if (!trackingColumn && columns.length > 0) {
                const colNames = new Set(columns.map((c) => c.name))
                if (colNames.has('updated_at')) {
                    trackingColumn = 'updated_at'
                } else if (colNames.has('created_at')) {
                    trackingColumn = 'created_at'
                } else {
                    const pkCol = columns.find((c) => c.isPrimaryKey)
                    if (pkCol) {
                        trackingColumn = pkCol.name
                    } else if (colNames.has('id')) {
                        trackingColumn = 'id'
                    }
                }
            }

            // 3. Create internal table if we have column definitions from schema introspection
            if (columns.length > 0) {
                await this.ensureInternalTableSchema(
                    tableCfg.internalTable,
                    columns
                )
            }

            // 4. Pull records in batches from external database
            let offset = 0
            let syncedInRun = 0
            let tableCreatedFromRow = columns.length > 0

            while (true) {
                const fetchQuery = this.syncSource.getFetchRecordsQuery({
                    schema: tableCfg.sourceSchema,
                    table: tableCfg.sourceTable,
                    trackingColumn,
                    lastValue: lastSyncValue,
                    batchSize: tableCfg.batchSize,
                    offset,
                })

                const rawRecords = await executeExternalQuery({
                    sql: fetchQuery.sql,
                    params: fetchQuery.params,
                    dataSource: this.dataSource,
                    config: this.config || { role: 'admin' },
                })
                const rows = normalizeExternalRows(rawRecords)

                if (rows.length === 0) {
                    break
                }

                // Fallback schema inference if information_schema returned no rows
                if (!tableCreatedFromRow) {
                    columns = this.inferColumnsFromRow(
                        rows[0],
                        tableCfg.primaryKey
                    )
                    await this.ensureInternalTableSchema(
                        tableCfg.internalTable,
                        columns
                    )
                    tableCreatedFromRow = true
                }

                for (const row of rows) {
                    const rowKeys = Object.keys(row)
                    if (rowKeys.length === 0) continue

                    const quotedInternalTable = quoteSqlIdentifier(
                        tableCfg.internalTable
                    )
                    const quotedCols = rowKeys
                        .map((k) => quoteSqlIdentifier(k))
                        .join(', ')
                    const placeholders = rowKeys.map(() => '?').join(', ')
                    const values = rowKeys.map((k) =>
                        serializeSqliteValue(row[k])
                    )

                    await this.dataSource.rpc.executeQuery({
                        sql: `INSERT OR REPLACE INTO ${quotedInternalTable} (${quotedCols}) VALUES (${placeholders})`,
                        params: values,
                    })

                    if (
                        trackingColumn &&
                        row[trackingColumn] !== undefined &&
                        row[trackingColumn] !== null
                    ) {
                        lastSyncValue = String(row[trackingColumn])
                    }
                    syncedInRun++
                }

                if (rows.length < tableCfg.batchSize) {
                    break
                }

                // When filtering by `trackingColumn > lastSyncValue`, `lastSyncValue` advances each batch so offset stays 0.
                // When doing full-table pagination without a tracking column, advance offset.
                if (!trackingColumn) {
                    offset += tableCfg.batchSize
                }
            }

            totalRowsSynced += syncedInRun

            await this.dataSource.rpc.executeQuery({
                sql: SQL_QUERIES.UPSERT_METADATA,
                params: [
                    tableCfg.internalTable,
                    tableCfg.sourceSchema,
                    tableCfg.sourceTable,
                    trackingColumn ?? null,
                    Date.now(),
                    lastSyncValue !== null ? String(lastSyncValue) : null,
                    totalRowsSynced,
                    'synced',
                    null,
                ],
            })

            return {
                table: tableCfg.internalTable,
                rowsSynced: syncedInRun,
                status: 'synced',
            }
        } catch (error: any) {
            const errorMessage =
                error instanceof Error ? error.message : String(error)

            await this.dataSource.rpc.executeQuery({
                sql: SQL_QUERIES.UPSERT_METADATA,
                params: [
                    tableCfg.internalTable,
                    tableCfg.sourceSchema,
                    tableCfg.sourceTable,
                    tableCfg.trackingColumn ?? null,
                    Date.now(),
                    lastSyncValue !== null ? String(lastSyncValue) : null,
                    totalRowsSynced,
                    'error',
                    errorMessage,
                ],
            })

            await this.dataSource.rpc.executeQuery({
                sql: SQL_QUERIES.INSERT_ERROR,
                params: [tableCfg.internalTable, errorMessage],
            })

            return {
                table: tableCfg.internalTable,
                rowsSynced: 0,
                status: 'error',
                error: errorMessage,
            }
        }
    }

    private inferColumnsFromRow(
        row: Record<string, any>,
        primaryKeyOverride?: string
    ): ColumnDefinition[] {
        const keys = Object.keys(row)
        return keys.map((key) => {
            const val = row[key]
            let sqliteType: SqliteColumnType = 'TEXT'
            if (typeof val === 'number') {
                sqliteType = Number.isInteger(val) ? 'INTEGER' : 'REAL'
            } else if (typeof val === 'boolean') {
                sqliteType = 'INTEGER'
            } else if (
                val instanceof Uint8Array ||
                val instanceof ArrayBuffer
            ) {
                sqliteType = 'BLOB'
            }

            const isPrimaryKey = primaryKeyOverride
                ? key === primaryKeyOverride
                : key === 'id'

            return {
                name: key,
                type: sqliteType,
                sqliteType,
                nullable: !isPrimaryKey,
                isPrimaryKey,
            }
        })
    }

    private async ensureInternalTableSchema(
        internalTable: string,
        columns: ColumnDefinition[]
    ): Promise<void> {
        if (!this.dataSource || columns.length === 0) return

        const quotedTable = quoteSqlIdentifier(internalTable)
        const pkColumns = columns.filter((c) => c.isPrimaryKey)
        const hasSinglePk = pkColumns.length === 1

        const colDefs = columns.map((col) => {
            const parts = [quoteSqlIdentifier(col.name), col.sqliteType]
            if (hasSinglePk && col.isPrimaryKey) {
                parts.push('PRIMARY KEY')
            } else if (!col.nullable) {
                parts.push('NOT NULL')
            }
            return parts.join(' ')
        })

        if (pkColumns.length > 1) {
            const compositeKeys = pkColumns
                .map((c) => quoteSqlIdentifier(c.name))
                .join(', ')
            colDefs.push(`PRIMARY KEY (${compositeKeys})`)
        }

        await this.dataSource.rpc.executeQuery({
            sql: `CREATE TABLE IF NOT EXISTS ${quotedTable} (${colDefs.join(', ')})`,
            params: [],
        })

        // Also check existing columns via PRAGMA table_info and add any missing columns
        const pragmaRows = ((await this.dataSource.rpc.executeQuery({
            sql: `PRAGMA table_info(${quotedTable})`,
            params: [],
        })) || []) as Record<string, any>[]

        if (pragmaRows.length > 0) {
            const existingNames = new Set(
                pragmaRows.map((r) => String(r.name))
            )
            for (const col of columns) {
                if (!existingNames.has(col.name)) {
                    await this.dataSource.rpc.executeQuery({
                        sql: `ALTER TABLE ${quotedTable} ADD COLUMN ${quoteSqlIdentifier(col.name)} ${col.sqliteType}`,
                        params: [],
                    })
                }
            }
        }
    }
}

export {
    DataSyncPlugin as ReplicationPlugin,
    DatabaseSyncSource as SyncAdapter,
    PostgresSyncSource as PostgresSync,
    PostgresSyncSource as PostgresSyncAdapter,
    MySQLSyncSource as MySQLSync,
    MySQLSyncSource as MySQLSyncAdapter,
}
