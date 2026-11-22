import postgres from 'postgres'
import { StarbaseApp, StarbaseDBConfiguration } from '../../src/handler'
import { executeExternalQuery as executeOperationExternalQuery } from '../../src/operation'
import { StarbasePlugin } from '../../src/plugin'
import { DataSource } from '../../src/types'
import { createResponse } from '../../src/utils'
import { PostgresSyncSource } from '../postgres-sync'

export { PostgresSyncSource, PostgresSyncSource as PostgresSync }

export interface TableSyncConfig {
    name: string
    schema?: string
    target_table?: string
    targetTable?: string
    timestamp_column?: string
    timestampColumn?: string
    id_column?: string
    idColumn?: string
    cursor_column?: string
    cursorColumn?: string
    track_column?: string
    trackColumn?: string
    primary_key?: string
    primaryKey?: string
    batch_size?: number
    batchSize?: number
    hasExplicitSyncColumns?: boolean
}

export interface SyncConfig {
    sync_interval: number
    tables: (string | TableSyncConfig)[]
    auto_sync?: boolean
}

export interface DataSyncOptions {
    sync_interval?: number
    syncInterval?: number
    tables?: (string | TableSyncConfig)[]
    auto_sync?: boolean
    autoSync?: boolean
    pathPrefix?: string
    dataSource?: DataSource
    config?: StarbaseDBConfiguration
    syncSource?: DatabaseSyncSource
}

export interface TableMetadata {
    lastSyncTimestamp: number
    lastSyncId?: string | number
    lastCursorValue?: string | number
    cursorColumn?: string
    rowsSynced?: number
    sync_errors?: string
}

export interface QueryResult {
    rows: any[][]
    columns: string[]
}

export interface ColumnDefinition {
    name: string
    type: string
    nullable?: boolean
    defaultValue?: string
    primaryKey?: boolean
}

export interface SyncSourceConfig {
    dialect?: string
    schema?: string
    queryExecutor?: (sql: string, params?: unknown[]) => Promise<any>
    [key: string]: any
}

export interface TableSyncResult {
    table: string
    sourceTable: string
    rowsSynced: number
    lastSyncTimestamp: number
    lastSyncId?: string | number
    lastCursorValue?: string | number
    error?: string
}

/**
 * Normalizes query results from either array-of-objects (`Record<string, any>[]`)
 * or raw tabular format (`{ rows: any[][], columns: string[] }`) into a unified `QueryResult`.
 */
export function normalizeToQueryResult(rawResult: any): QueryResult {
    if (!rawResult) {
        return { rows: [], columns: [] }
    }

    if (Array.isArray(rawResult)) {
        if (rawResult.length === 0) {
            return { rows: [], columns: [] }
        }

        if (Array.isArray(rawResult[0])) {
            return {
                rows: rawResult as any[][],
                columns: [],
            }
        }

        if (typeof rawResult[0] === 'object' && rawResult[0] !== null) {
            const columnSet = new Set<string>()
            for (const item of rawResult) {
                if (item && typeof item === 'object' && !Array.isArray(item)) {
                    for (const key of Object.keys(item)) {
                        columnSet.add(key)
                    }
                }
            }
            const columns = Array.from(columnSet)
            const rows = rawResult.map((item) =>
                columns.map((col) =>
                    item && typeof item === 'object' ? item[col] : undefined
                )
            )
            return { rows, columns }
        }

        return { rows: [], columns: [] }
    }

    if (typeof rawResult === 'object' && Array.isArray(rawResult.rows)) {
        const rawRows = rawResult.rows
        const rawCols: string[] = Array.isArray(rawResult.columns)
            ? rawResult.columns
            : []

        if (rawRows.length === 0 || Array.isArray(rawRows[0])) {
            return {
                rows: rawRows,
                columns: rawCols,
            }
        }

        if (typeof rawRows[0] === 'object' && rawRows[0] !== null) {
            let columns = rawCols
            if (columns.length === 0) {
                const columnSet = new Set<string>()
                for (const item of rawRows) {
                    if (
                        item &&
                        typeof item === 'object' &&
                        !Array.isArray(item)
                    ) {
                        for (const key of Object.keys(item)) {
                            columnSet.add(key)
                        }
                    }
                }
                columns = Array.from(columnSet)
            }
            const rows = rawRows.map((item: Record<string, any>) =>
                columns.map((col) =>
                    item && typeof item === 'object' ? item[col] : undefined
                )
            )
            return { rows, columns }
        }
    }

    return { rows: [], columns: [] }
}

/**
 * Sanitizes parameter values before writing to Cloudflare Durable Object SQLite (`SqlStorage`).
 */
export function sanitizeSQLiteValue(value: unknown): unknown {
    if (value === undefined || value === null) {
        return null
    }
    if (typeof value === 'boolean') {
        return value ? 1 : 0
    }
    if (typeof value === 'bigint') {
        const asNumber = Number(value)
        return Number.isSafeInteger(asNumber) ? asNumber : value.toString()
    }
    if (value instanceof Date) {
        return value.toISOString()
    }
    if (
        value instanceof Uint8Array ||
        (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer)
    ) {
        return value
    }
    if (typeof value === 'object') {
        return JSON.stringify(value)
    }
    return value
}

/**
 * Validates and escapes a SQL identifier (table, schema, or column name)
 * to prevent SQL injection while preserving simple identifier formatting.
 */
export function escapeIdentifier(identifier: string): string {
    const trimmed = String(identifier).trim()
    if (!trimmed || /[\0\r\n;]/.test(trimmed)) {
        throw new Error(`Invalid SQL identifier: ${identifier}`)
    }
    if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(trimmed)) {
        return trimmed
    }
    return `"${trimmed.replace(/"/g, '""')}"`
}

/**
 * Transforms SQL segments outside single-quoted string literals.
 */
function transformOutsideSingleQuotes(
    sql: string,
    transformer: (segment: string) => string
): string {
    const parts = sql.split(/('(?:''|[^'])*')/g)
    return parts
        .map((part, index) => (index % 2 === 1 ? part : transformer(part)))
        .join('')
}

/**
 * Abstract base class for external database sync sources.
 */
export abstract class DatabaseSyncSource {
    protected dataSource?: DataSource
    protected starbaseConfig?: StarbaseDBConfiguration
    protected config: SyncSourceConfig

    constructor(config: SyncSourceConfig = {}) {
        this.config = config
    }

    abstract get dialect(): string

    async setDataSource(
        dataSource: DataSource,
        starbaseConfig?: StarbaseDBConfiguration
    ): Promise<void> {
        this.dataSource = dataSource
        if (starbaseConfig) {
            this.starbaseConfig = starbaseConfig
        }
    }

    protected getExternalDataSource(): DataSource | undefined {
        if (!this.dataSource?.external) {
            return undefined
        }
        return this.dataSource
    }

    protected getRowValue(
        row: any[] | Record<string, any>,
        columns: string[],
        columnName: string,
        fallbackIndex: number
    ): any {
        if (row && !Array.isArray(row) && typeof row === 'object') {
            if (columnName in row) {
                return row[columnName]
            }
            const lower = columnName.toLowerCase()
            const matchedKey = Object.keys(row).find(
                (k) => k.toLowerCase() === lower
            )
            if (matchedKey !== undefined) {
                return row[matchedKey]
            }
        }

        if (Array.isArray(row)) {
            if (columns && columns.length > 0) {
                const lower = columnName.toLowerCase()
                const colIdx = columns.findIndex(
                    (c) => c.toLowerCase() === lower
                )
                if (colIdx !== -1) {
                    return row[colIdx]
                }
            }
            return row[fallbackIndex]
        }

        return undefined
    }

    /**
     * Executes a query against the external data source.
     */
    public async executeExternalQuery(
        sql: string,
        params: unknown[] = []
    ): Promise<QueryResult> {
        if (typeof this.config.queryExecutor === 'function') {
            const raw = await this.config.queryExecutor(sql, params)
            return normalizeToQueryResult(raw)
        }

        const externalDs = this.getExternalDataSource()
        if (!externalDs || !externalDs.external) {
            throw new Error('External data source not configured')
        }

        const extAny = externalDs.external as any
        if (typeof extAny.queryExecutor === 'function') {
            const raw = await extAny.queryExecutor(sql, params)
            return normalizeToQueryResult(raw)
        }

        if (typeof extAny.rpc?.executeQuery === 'function') {
            const raw = await extAny.rpc.executeQuery({ sql, params })
            return normalizeToQueryResult(raw)
        }

        const isMockRpc =
            typeof externalDs.rpc?.executeQuery === 'function' &&
            'mock' in (externalDs.rpc.executeQuery as any)

        if (this.starbaseConfig?.outerbaseApiKey) {
            const raw = await executeOperationExternalQuery({
                sql,
                params,
                dataSource: externalDs,
                config: this.starbaseConfig,
            })
            return normalizeToQueryResult(raw)
        }

        if (isMockRpc) {
            const raw = await externalDs.rpc.executeQuery({ sql, params })
            return normalizeToQueryResult(raw)
        }

        if (
            'connectionString' in externalDs.external &&
            externalDs.external.connectionString
        ) {
            const pgClient = postgres(externalDs.external.connectionString, {
                max: 5,
                fetch_types: false,
            })

            try {
                let queryStr = sql
                if (params.length > 0 && queryStr.includes('?')) {
                    let paramIdx = 1
                    queryStr = transformOutsideSingleQuotes(queryStr, (seg) =>
                        seg.replace(/\?/g, () => `$${paramIdx++}`)
                    )
                }

                const raw = await pgClient.unsafe(queryStr, params as any[])
                if (externalDs.executionContext) {
                    externalDs.executionContext.waitUntil(pgClient.end())
                } else {
                    await pgClient.end()
                }
                return normalizeToQueryResult(raw)
            } catch (error) {
                await pgClient.end().catch(() => {})
                throw error
            }
        }

        const raw = await executeOperationExternalQuery({
            sql,
            params,
            dataSource: externalDs,
            config: this.starbaseConfig || { role: 'admin' },
        })
        return normalizeToQueryResult(raw)
    }

    abstract validateConnection(): Promise<boolean>
    abstract getTableSchema(
        tableName: string,
        schema?: string
    ): Promise<ColumnDefinition[]>
    abstract getIncrementalData(
        tableName: string,
        lastSync: TableMetadata,
        tableConfig: TableSyncConfig
    ): Promise<QueryResult>
    abstract mapDataType(sourceType: string): string
    abstract validateTableStructure(
        tableName: string,
        tableConfig: TableSyncConfig
    ): Promise<{ valid: boolean; errors: string[] }>
}

/**
 * MySQL Sync Source adapter for pulling schema and data from external MySQL databases.
 */
export class MySQLSyncSource extends DatabaseSyncSource {
    private schema?: string

    constructor(config: SyncSourceConfig = {}) {
        super({
            ...config,
            dialect: 'mysql',
        })
        this.schema = config.schema
    }

    get dialect(): string {
        return 'mysql'
    }

    async validateConnection(): Promise<boolean> {
        const externalDataSource = this.getExternalDataSource()
        if (
            !externalDataSource ||
            externalDataSource.external?.dialect !== 'mysql'
        ) {
            return false
        }

        try {
            await this.executeExternalQuery('SELECT VERSION()')
            return true
        } catch (error) {
            console.error('MySQL connection validation failed:', error)
            return false
        }
    }

    async getTableSchema(
        tableName: string,
        schema?: string
    ): Promise<ColumnDefinition[]> {
        const externalDataSource = this.getExternalDataSource()
        if (!externalDataSource) {
            throw new Error('External data source not configured')
        }

        let targetSchema =
            schema ||
            this.schema ||
            (externalDataSource.external as any)?.database
        let cleanTableName = tableName.replace(/^tmp_/, '')
        if (cleanTableName.includes('.')) {
            const parts = cleanTableName.split('.', 2)
            targetSchema = schema || parts[0]
            cleanTableName = parts[1]
        }

        const result = await this.executeExternalQuery(
            `SELECT 
                COLUMN_NAME, 
                DATA_TYPE,
                COLUMN_TYPE,
                IS_NULLABLE,
                COLUMN_DEFAULT,
                CHARACTER_MAXIMUM_LENGTH,
                COLUMN_KEY
            FROM information_schema.columns 
            WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ?
            ORDER BY ORDINAL_POSITION`,
            [targetSchema || null, cleanTableName]
        )

        return (result.rows || []).map((row: any[]) => {
            const name = String(
                this.getRowValue(row, result.columns, 'COLUMN_NAME', 0)
            )
            const dataType = String(
                this.getRowValue(row, result.columns, 'DATA_TYPE', 1) || 'text'
            )
            const isNullable = this.getRowValue(
                row,
                result.columns,
                'IS_NULLABLE',
                3
            )
            const colDefault = this.getRowValue(
                row,
                result.columns,
                'COLUMN_DEFAULT',
                4
            )
            const colKey = this.getRowValue(
                row,
                result.columns,
                'COLUMN_KEY',
                6
            )

            return {
                name,
                type: dataType,
                nullable:
                    isNullable === 'YES' ||
                    isNullable === true ||
                    isNullable === 1,
                defaultValue:
                    colDefault !== null && colDefault !== undefined
                        ? String(colDefault)
                        : undefined,
                primaryKey: colKey === 'PRI',
            }
        })
    }

    mapDataType(mysqlType: string): string {
        const baseType = mysqlType
            .toLowerCase()
            .replace(/\(.*\)/, '')
            .trim()
        const typeMap: Record<string, string> = {
            int: 'INTEGER',
            integer: 'INTEGER',
            tinyint: 'INTEGER',
            smallint: 'INTEGER',
            mediumint: 'INTEGER',
            bigint: 'INTEGER',
            bit: 'INTEGER',
            bool: 'INTEGER',
            boolean: 'INTEGER',
            year: 'INTEGER',
            float: 'REAL',
            double: 'REAL',
            'double precision': 'REAL',
            decimal: 'REAL',
            dec: 'REAL',
            numeric: 'REAL',
            fixed: 'REAL',
            real: 'REAL',
            blob: 'BLOB',
            tinyblob: 'BLOB',
            mediumblob: 'BLOB',
            longblob: 'BLOB',
            binary: 'BLOB',
            varbinary: 'BLOB',
            varchar: 'TEXT',
            char: 'TEXT',
            text: 'TEXT',
            tinytext: 'TEXT',
            mediumtext: 'TEXT',
            longtext: 'TEXT',
            json: 'TEXT',
            date: 'TEXT',
            datetime: 'TEXT',
            timestamp: 'TEXT',
            time: 'TEXT',
            enum: 'TEXT',
            set: 'TEXT',
        }

        return typeMap[baseType] || 'TEXT'
    }

    async validateTableStructure(
        tableName: string,
        tableConfig: TableSyncConfig
    ): Promise<{ valid: boolean; errors: string[] }> {
        const errors: string[] = []
        const sourceTable = tableConfig.name || tableName
        const columns = await this.getTableSchema(
            sourceTable,
            tableConfig.schema
        )

        if (columns.length === 0) {
            return {
                valid: false,
                errors: [`Table ${sourceTable} does not exist`],
            }
        }

        if (tableConfig.hasExplicitSyncColumns === false) {
            return { valid: true, errors: [] }
        }

        const cursorCol =
            tableConfig.cursor_column ||
            tableConfig.cursorColumn ||
            tableConfig.track_column ||
            tableConfig.trackColumn

        if (
            cursorCol &&
            (tableConfig as any).explicitCursorColumn !== false &&
            !columns.some((c) => c.name === cursorCol)
        ) {
            errors.push(
                `Cursor column ${cursorCol} not found in table ${sourceTable}`
            )
        }

        const tsCol =
            tableConfig.timestamp_column || tableConfig.timestampColumn
        if (
            tsCol &&
            (tableConfig as any).explicitTimestampColumn !== false &&
            !columns.some((c) => c.name === tsCol)
        ) {
            errors.push(
                `Timestamp column ${tsCol} not found in table ${sourceTable}`
            )
        }

        const idCol = tableConfig.id_column || tableConfig.idColumn
        if (
            idCol &&
            (tableConfig as any).explicitIdColumn !== false &&
            !columns.some((c) => c.name === idCol)
        ) {
            errors.push(`ID column ${idCol} not found in table ${sourceTable}`)
        }

        return {
            valid: errors.length === 0,
            errors,
        }
    }

    async getIncrementalData(
        tableName: string,
        lastSync: TableMetadata,
        tableConfig: TableSyncConfig
    ): Promise<QueryResult> {
        const externalDataSource = this.getExternalDataSource()
        if (!externalDataSource) {
            throw new Error('External data source not configured')
        }

        const sourceTable = tableConfig.name || tableName.replace(/^tmp_/, '')
        const safeSourceTable = escapeIdentifier(sourceTable)
        const qualifiedTable =
            tableConfig.schema && tableConfig.schema !== 'public'
                ? `${escapeIdentifier(tableConfig.schema)}.${safeSourceTable}`
                : safeSourceTable

        const cursorCol =
            tableConfig.cursor_column ||
            tableConfig.cursorColumn ||
            tableConfig.track_column ||
            tableConfig.trackColumn
        const timestampCol =
            tableConfig.timestamp_column || tableConfig.timestampColumn
        const idCol = tableConfig.id_column || tableConfig.idColumn

        let query = `SELECT * FROM ${qualifiedTable}`
        const conditions: string[] = []
        const params: any[] = []

        if (cursorCol) {
            if (
                lastSync.lastCursorValue !== undefined &&
                lastSync.lastCursorValue !== null
            ) {
                conditions.push(`${escapeIdentifier(cursorCol)} > ?`)
                params.push(lastSync.lastCursorValue)
            }
        } else {
            if (lastSync.lastSyncTimestamp && timestampCol) {
                conditions.push(`${escapeIdentifier(timestampCol)} > ?`)
                params.push(new Date(lastSync.lastSyncTimestamp).toISOString())
            }
            if (
                lastSync.lastSyncId !== undefined &&
                lastSync.lastSyncId !== null &&
                idCol
            ) {
                conditions.push(`${escapeIdentifier(idCol)} > ?`)
                params.push(lastSync.lastSyncId)
            }
        }

        if (conditions.length > 0) {
            query += ' WHERE ' + conditions.join(' AND ')
        }

        const orderColumns = (
            cursorCol ? [cursorCol] : [timestampCol, idCol].filter(Boolean)
        ).map((c) => escapeIdentifier(c!))
        if (orderColumns.length > 0) {
            query += ' ORDER BY ' + orderColumns.join(', ') + ' ASC'
        }

        const batchSize = Math.max(
            1,
            Math.floor(
                Number(tableConfig.batch_size || tableConfig.batchSize || 1000)
            )
        )
        query += ` LIMIT ${batchSize}`

        return await this.executeExternalQuery(query, params)
    }
}

export { MySQLSyncSource as MySQLSync }

/**
 * SQLite Sync Source adapter for pulling schema and data from external SQLite databases
 * (Turso, Cloudflare D1, or external StarbaseDB).
 */
export class SQLiteSyncSource extends DatabaseSyncSource {
    constructor(config: SyncSourceConfig = {}) {
        super({
            ...config,
            dialect: 'sqlite',
        })
    }

    get dialect(): string {
        return 'sqlite'
    }

    async validateConnection(): Promise<boolean> {
        const externalDataSource = this.getExternalDataSource()
        if (
            !externalDataSource ||
            externalDataSource.external?.dialect !== 'sqlite'
        ) {
            return false
        }

        try {
            await this.executeExternalQuery('SELECT sqlite_version()')
            return true
        } catch (error) {
            console.error('SQLite connection validation failed:', error)
            return false
        }
    }

    async getTableSchema(tableName: string): Promise<ColumnDefinition[]> {
        const externalDataSource = this.getExternalDataSource()
        if (!externalDataSource) {
            throw new Error('External data source not configured')
        }

        let cleanTableName = tableName.replace(/^tmp_/, '')
        if (cleanTableName.includes('.')) {
            cleanTableName = cleanTableName.split('.', 2)[1]
        }

        const result = await this.executeExternalQuery(
            `SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(?)`,
            [cleanTableName]
        )

        return (result.rows || []).map((row: any[]) => {
            const hasCidOffset =
                result.columns.length === 0 &&
                row.length >= 6 &&
                typeof row[0] === 'number'
            const name = String(
                this.getRowValue(
                    row,
                    result.columns,
                    'name',
                    hasCidOffset ? 1 : 0
                )
            )
            const type = String(
                this.getRowValue(
                    row,
                    result.columns,
                    'type',
                    hasCidOffset ? 2 : 1
                ) || 'TEXT'
            )
            const notNullVal = this.getRowValue(
                row,
                result.columns,
                'notnull',
                hasCidOffset ? 3 : 2
            )
            const defaultVal = this.getRowValue(
                row,
                result.columns,
                'dflt_value',
                hasCidOffset ? 4 : 3
            )
            const pkVal = this.getRowValue(
                row,
                result.columns,
                'pk',
                hasCidOffset ? 5 : 4
            )

            return {
                name,
                type,
                nullable:
                    notNullVal === 0 ||
                    notNullVal === false ||
                    notNullVal === '0' ||
                    notNullVal === undefined,
                defaultValue:
                    defaultVal !== null && defaultVal !== undefined
                        ? String(defaultVal)
                        : undefined,
                primaryKey: pkVal === 1 || pkVal === true || Number(pkVal) > 0,
            }
        })
    }

    mapDataType(sqliteType: string): string {
        const upper = sqliteType.toUpperCase().trim()
        if (upper.includes('INT') || upper === 'BOOLEAN' || upper === 'BOOL') {
            return 'INTEGER'
        }
        if (
            upper.includes('REAL') ||
            upper.includes('FLOA') ||
            upper.includes('DOUB') ||
            upper.includes('NUMERIC') ||
            upper.includes('DECIMAL')
        ) {
            return 'REAL'
        }
        if (upper.includes('BLOB') || upper.includes('BINARY')) {
            return 'BLOB'
        }
        return 'TEXT'
    }

    async validateTableStructure(
        tableName: string,
        tableConfig: TableSyncConfig
    ): Promise<{ valid: boolean; errors: string[] }> {
        const errors: string[] = []
        const sourceTable = tableConfig.name || tableName
        const columns = await this.getTableSchema(sourceTable)

        if (columns.length === 0) {
            return {
                valid: false,
                errors: [`Table ${sourceTable} does not exist`],
            }
        }

        if (tableConfig.hasExplicitSyncColumns === false) {
            return { valid: true, errors: [] }
        }

        const cursorCol =
            tableConfig.cursor_column ||
            tableConfig.cursorColumn ||
            tableConfig.track_column ||
            tableConfig.trackColumn

        if (
            cursorCol &&
            (tableConfig as any).explicitCursorColumn !== false &&
            !columns.some((c) => c.name === cursorCol)
        ) {
            errors.push(
                `Cursor column ${cursorCol} not found in table ${sourceTable}`
            )
        }

        const tsCol =
            tableConfig.timestamp_column || tableConfig.timestampColumn
        if (
            tsCol &&
            (tableConfig as any).explicitTimestampColumn !== false &&
            !columns.some((c) => c.name === tsCol)
        ) {
            errors.push(
                `Timestamp column ${tsCol} not found in table ${sourceTable}`
            )
        }

        const idCol = tableConfig.id_column || tableConfig.idColumn
        if (
            idCol &&
            (tableConfig as any).explicitIdColumn !== false &&
            !columns.some((c) => c.name === idCol)
        ) {
            errors.push(`ID column ${idCol} not found in table ${sourceTable}`)
        }

        return {
            valid: errors.length === 0,
            errors,
        }
    }

    async getIncrementalData(
        tableName: string,
        lastSync: TableMetadata,
        tableConfig: TableSyncConfig
    ): Promise<QueryResult> {
        const externalDataSource = this.getExternalDataSource()
        if (!externalDataSource) {
            throw new Error('External data source not configured')
        }

        const sourceTable = tableConfig.name || tableName.replace(/^tmp_/, '')
        const cursorCol =
            tableConfig.cursor_column ||
            tableConfig.cursorColumn ||
            tableConfig.track_column ||
            tableConfig.trackColumn
        const timestampCol =
            tableConfig.timestamp_column || tableConfig.timestampColumn
        const idCol = tableConfig.id_column || tableConfig.idColumn

        let query = `SELECT * FROM ${escapeIdentifier(sourceTable)}`
        const conditions: string[] = []
        const params: any[] = []

        if (cursorCol) {
            if (
                lastSync.lastCursorValue !== undefined &&
                lastSync.lastCursorValue !== null
            ) {
                conditions.push(`${escapeIdentifier(cursorCol)} > ?`)
                params.push(lastSync.lastCursorValue)
            }
        } else {
            if (lastSync.lastSyncTimestamp && timestampCol) {
                conditions.push(`${escapeIdentifier(timestampCol)} > ?`)
                params.push(new Date(lastSync.lastSyncTimestamp).toISOString())
            }
            if (
                lastSync.lastSyncId !== undefined &&
                lastSync.lastSyncId !== null &&
                idCol
            ) {
                conditions.push(`${escapeIdentifier(idCol)} > ?`)
                params.push(lastSync.lastSyncId)
            }
        }

        if (conditions.length > 0) {
            query += ' WHERE ' + conditions.join(' AND ')
        }

        const orderColumns = (
            cursorCol ? [cursorCol] : [timestampCol, idCol].filter(Boolean)
        ).map((c) => escapeIdentifier(c!))
        if (orderColumns.length > 0) {
            query += ' ORDER BY ' + orderColumns.join(', ') + ' ASC'
        }

        const batchSize = Math.max(
            1,
            Math.floor(
                Number(tableConfig.batch_size || tableConfig.batchSize || 1000)
            )
        )
        query += ` LIMIT ${batchSize}`

        return await this.executeExternalQuery(query, params)
    }
}

export { SQLiteSyncSource as SQLiteSync }

/**
 * StarbaseDB plugin that replicates data from an external data source
 * (PostgreSQL, MySQL, Turso, Cloudflare D1, StarbaseDB, Hyperdrive, or Outerbase API)
 * into the internal Durable Object SQLite database.
 */
export class DataSyncPlugin extends StarbasePlugin {
    public pathPrefix: string = '/sync'
    private syncInterval: number
    private tables: Map<string, TableSyncConfig>
    private schemaTableMap: Map<string, string>
    private autoSync: boolean
    private dataSource?: DataSource
    private starbaseConfig?: StarbaseDBConfiguration
    private syncSource: DatabaseSyncSource
    private hasExplicitSyncSource: boolean
    private timerId?: ReturnType<typeof setInterval>
    private syncMetadata: Map<string, TableMetadata> = new Map()
    private lastSyncAttempt: Map<string, number> = new Map()
    private isMetadataInitialized: boolean = false

    constructor(
        syncSourceOrOpts?: DatabaseSyncSource | DataSyncOptions,
        opts?: DataSyncOptions
    ) {
        super('starbasedb:data-sync', { requiresAuth: true }, '/sync')

        const isSyncSource =
            syncSourceOrOpts instanceof DatabaseSyncSource ||
            Boolean(
                syncSourceOrOpts &&
                    typeof syncSourceOrOpts === 'object' &&
                    'validateConnection' in syncSourceOrOpts &&
                    'getTableSchema' in syncSourceOrOpts
            )

        let resolvedOpts: DataSyncOptions
        if (isSyncSource) {
            this.syncSource = syncSourceOrOpts as DatabaseSyncSource
            this.hasExplicitSyncSource = true
            resolvedOpts = opts || {}
        } else {
            resolvedOpts = (syncSourceOrOpts as DataSyncOptions) || opts || {}
            this.hasExplicitSyncSource = Boolean(resolvedOpts.syncSource)
            this.syncSource =
                resolvedOpts.syncSource || new PostgresSyncSource()
        }

        if (resolvedOpts.pathPrefix) {
            this.pathPrefix = resolvedOpts.pathPrefix
        }

        const intervalSeconds =
            resolvedOpts.sync_interval ?? resolvedOpts.syncInterval ?? 60
        this.syncInterval = intervalSeconds * 1000
        this.autoSync = resolvedOpts.auto_sync ?? resolvedOpts.autoSync ?? true
        this.tables = new Map()
        this.schemaTableMap = new Map()

        const configuredTables = resolvedOpts.tables || []
        for (const table of configuredTables) {
            this.registerTableConfig(table)
        }

        if (resolvedOpts.dataSource) {
            this.dataSource = resolvedOpts.dataSource
            this.starbaseConfig = resolvedOpts.config
        }
    }

    private registerTableConfig(table: string | TableSyncConfig): void {
        if (typeof table === 'string') {
            let parsedSchema: string | undefined
            let parsedName = table.trim()

            if (parsedName.includes('.')) {
                const parts = parsedName.split('.', 2)
                parsedSchema = parts[0]
                parsedName = parts[1]
            }

            const configObj: TableSyncConfig = {
                name: parsedName,
                ...(parsedSchema && parsedSchema !== 'public'
                    ? { schema: parsedSchema }
                    : {}),
                timestamp_column: 'created_at',
                id_column: 'id',
                batch_size: 1000,
            }

            Object.defineProperties(configObj, {
                hasExplicitSyncColumns: {
                    value: false,
                    enumerable: false,
                    writable: true,
                    configurable: true,
                },
                explicitTimestampColumn: {
                    value: false,
                    enumerable: false,
                    writable: true,
                    configurable: true,
                },
                explicitIdColumn: {
                    value: false,
                    enumerable: false,
                    writable: true,
                    configurable: true,
                },
                explicitCursorColumn: {
                    value: false,
                    enumerable: false,
                    writable: true,
                    configurable: true,
                },
            })

            const sqliteTableName = this.getSQLiteTableName(
                configObj,
                parsedSchema
            )
            this.tables.set(sqliteTableName, configObj)
            this.registerSchemaMapping(
                parsedSchema,
                parsedName,
                sqliteTableName
            )
            return
        }

        let parsedSchema = table.schema
        let parsedName = table.name.trim()
        if (!parsedSchema && parsedName.includes('.')) {
            const parts = parsedName.split('.', 2)
            parsedSchema = parts[0]
            parsedName = parts[1]
        }

        const rawTsCol = table.timestamp_column ?? table.timestampColumn
        const rawIdCol = table.id_column ?? table.idColumn
        const rawCursorCol =
            table.cursor_column ??
            table.cursorColumn ??
            table.track_column ??
            table.trackColumn
        const rawTargetTable = table.target_table ?? table.targetTable
        const rawPrimaryKey = table.primary_key ?? table.primaryKey
        const rawBatchSize = table.batch_size ?? table.batchSize ?? 1000

        const hasExplicitTs = Boolean(rawTsCol)
        const hasExplicitId = Boolean(rawIdCol)
        const hasExplicitCursor = Boolean(rawCursorCol)
        const hasExplicit =
            table.hasExplicitSyncColumns !== undefined
                ? table.hasExplicitSyncColumns
                : hasExplicitTs || hasExplicitId || hasExplicitCursor

        const configObj: TableSyncConfig = {
            name: parsedName,
            ...(parsedSchema ? { schema: parsedSchema } : {}),
            ...(rawTargetTable ? { target_table: rawTargetTable } : {}),
            ...(rawCursorCol ? { cursor_column: rawCursorCol } : {}),
            ...(rawPrimaryKey ? { primary_key: rawPrimaryKey } : {}),
            timestamp_column: rawTsCol || 'created_at',
            id_column: rawIdCol || 'id',
            batch_size: rawBatchSize,
        }

        Object.defineProperties(configObj, {
            hasExplicitSyncColumns: {
                value: hasExplicit,
                enumerable: false,
                writable: true,
                configurable: true,
            },
            explicitTimestampColumn: {
                value: hasExplicitTs,
                enumerable: false,
                writable: true,
                configurable: true,
            },
            explicitIdColumn: {
                value: hasExplicitId,
                enumerable: false,
                writable: true,
                configurable: true,
            },
            explicitCursorColumn: {
                value: hasExplicitCursor,
                enumerable: false,
                writable: true,
                configurable: true,
            },
        })

        const sqliteTableName = this.getSQLiteTableName(configObj, parsedSchema)
        this.tables.set(sqliteTableName, configObj)
        this.registerSchemaMapping(parsedSchema, parsedName, sqliteTableName)
    }

    public getSQLiteTableName(
        config: TableSyncConfig,
        explicitSchema?: string
    ): string {
        const targetOverride = config.target_table || config.targetTable
        if (targetOverride) {
            return targetOverride
        }

        const schema = explicitSchema || config.schema
        if (!schema || schema === 'public' || schema === 'main') {
            return config.name
        }

        return `${schema}_${config.name}`
    }

    private registerSchemaMapping(
        schema: string | undefined,
        tableName: string,
        sqliteTableName: string
    ): void {
        const effectiveSchema = schema || 'public'
        this.schemaTableMap.set(
            `${effectiveSchema}.${tableName}`.toLowerCase(),
            sqliteTableName
        )
        this.schemaTableMap.set(
            `public.${tableName}`.toLowerCase(),
            sqliteTableName
        )
    }

    private resolveTableEntry(
        tableName: string
    ): { sqliteTableName: string; config: TableSyncConfig } | undefined {
        const direct = this.tables.get(tableName)
        if (direct) {
            return { sqliteTableName: tableName, config: direct }
        }

        const cleaned = tableName.replace(/^tmp_/, '')
        const directCleaned = this.tables.get(cleaned)
        if (directCleaned) {
            return { sqliteTableName: cleaned, config: directCleaned }
        }

        const mappedName = this.schemaTableMap.get(cleaned.toLowerCase())
        if (mappedName && this.tables.has(mappedName)) {
            return {
                sqliteTableName: mappedName,
                config: this.tables.get(mappedName)!,
            }
        }

        for (const [sqliteName, cfg] of this.tables.entries()) {
            if (
                cfg.name === cleaned ||
                `${cfg.schema || 'public'}.${cfg.name}` === cleaned
            ) {
                return { sqliteTableName: sqliteName, config: cfg }
            }
        }

        return undefined
    }

    public async setDataSource(
        dataSource: DataSource,
        starbaseConfig?: StarbaseDBConfiguration
    ): Promise<void> {
        this.dataSource = dataSource
        if (starbaseConfig) {
            this.starbaseConfig = starbaseConfig
        }

        if (!this.hasExplicitSyncSource && dataSource?.external?.dialect) {
            const extDialect = dataSource.external.dialect
            if (extDialect === 'mysql' && this.syncSource.dialect !== 'mysql') {
                this.syncSource = new MySQLSyncSource()
            } else if (
                extDialect === 'sqlite' &&
                this.syncSource.dialect !== 'sqlite'
            ) {
                this.syncSource = new SQLiteSyncSource()
            } else if (
                extDialect === 'postgresql' &&
                this.syncSource.dialect !== 'postgresql'
            ) {
                this.syncSource = new PostgresSyncSource()
            }
        }

        await this.syncSource.setDataSource(dataSource, this.starbaseConfig)
    }

    private async createMetadataTable(): Promise<void> {
        if (!this.dataSource) return

        const sql = `
            CREATE TABLE IF NOT EXISTS tmp_data_sync_metadata (
                table_name TEXT PRIMARY KEY,
                source_table TEXT,
                last_sync_timestamp INTEGER,
                last_sync_id TEXT,
                last_cursor_value TEXT,
                cursor_column TEXT,
                rows_synced INTEGER DEFAULT 0,
                sync_errors TEXT
            )
        `
        await this.dataSource.rpc.executeQuery({ sql, params: [] })
    }

    private async loadSyncMetadata(): Promise<void> {
        if (!this.dataSource) return

        const sql = `SELECT * FROM tmp_data_sync_metadata`
        const rawResult = await this.dataSource.rpc.executeQuery({
            sql,
            params: [],
        })
        const result = normalizeToQueryResult(rawResult)

        for (const row of result.rows) {
            const isLegacyFourCol =
                result.columns.length === 0 && row.length === 4
            const tableName = String(
                this.syncSource['getRowValue'](
                    row,
                    result.columns,
                    'table_name',
                    0
                )
            )
            const lastSyncTsRaw = this.syncSource['getRowValue'](
                row,
                result.columns,
                'last_sync_timestamp',
                isLegacyFourCol ? 1 : 2
            )
            const lastSyncIdRaw = this.syncSource['getRowValue'](
                row,
                result.columns,
                'last_sync_id',
                isLegacyFourCol ? 2 : 3
            )
            const lastCursorRaw = isLegacyFourCol
                ? undefined
                : this.syncSource['getRowValue'](
                      row,
                      result.columns,
                      'last_cursor_value',
                      4
                  )
            const cursorColRaw = isLegacyFourCol
                ? undefined
                : this.syncSource['getRowValue'](
                      row,
                      result.columns,
                      'cursor_column',
                      5
                  )
            const rowsSyncedRaw = isLegacyFourCol
                ? undefined
                : this.syncSource['getRowValue'](
                      row,
                      result.columns,
                      'rows_synced',
                      6
                  )
            const syncErrorsRaw = this.syncSource['getRowValue'](
                row,
                result.columns,
                'sync_errors',
                isLegacyFourCol ? 3 : 7
            )

            this.syncMetadata.set(tableName, {
                lastSyncTimestamp: Number(lastSyncTsRaw) || 0,
                lastSyncId:
                    lastSyncIdRaw !== null && lastSyncIdRaw !== undefined
                        ? lastSyncIdRaw
                        : undefined,
                lastCursorValue:
                    lastCursorRaw !== null && lastCursorRaw !== undefined
                        ? lastCursorRaw
                        : undefined,
                cursorColumn:
                    cursorColRaw !== null && cursorColRaw !== undefined
                        ? String(cursorColRaw)
                        : undefined,
                rowsSynced:
                    rowsSyncedRaw !== null && rowsSyncedRaw !== undefined
                        ? Number(rowsSyncedRaw)
                        : undefined,
                sync_errors:
                    syncErrorsRaw !== null && syncErrorsRaw !== undefined
                        ? String(syncErrorsRaw)
                        : undefined,
            })
        }
    }

    private async updateSyncMetadata(
        tableName: string,
        metadata: TableMetadata,
        sourceTable?: string
    ): Promise<void> {
        if (!this.dataSource) return

        this.syncMetadata.set(tableName, metadata)

        const sql = `
            INSERT OR REPLACE INTO tmp_data_sync_metadata 
            (table_name, source_table, last_sync_timestamp, last_sync_id, last_cursor_value, cursor_column, rows_synced, sync_errors)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `
        const params = [
            tableName,
            sourceTable || tableName,
            metadata.lastSyncTimestamp ?? 0,
            metadata.lastSyncId !== undefined && metadata.lastSyncId !== null
                ? String(metadata.lastSyncId)
                : null,
            metadata.lastCursorValue !== undefined &&
            metadata.lastCursorValue !== null
                ? String(metadata.lastCursorValue)
                : null,
            metadata.cursorColumn ?? null,
            metadata.rowsSynced ?? 0,
            metadata.sync_errors ?? null,
        ]

        try {
            await this.dataSource.rpc.executeQuery({ sql, params })
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error)
            if (msg.toLowerCase().includes('no such table')) {
                await this.createMetadataTable()
                await this.dataSource.rpc.executeQuery({ sql, params })
            } else {
                throw error
            }
        }
    }

    private async createTempTable(
        tableName: string,
        columns: ColumnDefinition[],
        tableConfig?: TableSyncConfig
    ): Promise<void> {
        if (!this.dataSource) {
            throw new Error('Internal data source not configured')
        }

        const configuredPk = tableConfig?.primary_key || tableConfig?.primaryKey

        const columnDefs = columns
            .map((col) => {
                const type = this.syncSource.mapDataType(col.type)
                const isPk =
                    col.primaryKey ||
                    (configuredPk &&
                        col.name.toLowerCase() === configuredPk.toLowerCase())
                const pkClause = isPk ? ' PRIMARY KEY' : ''
                const nullable = col.nullable === false ? ' NOT NULL' : ''
                const defaultValue = col.defaultValue
                    ? ` DEFAULT ${col.defaultValue}`
                    : ''
                return `${escapeIdentifier(col.name)} ${type}${pkClause}${nullable}${defaultValue}`
            })
            .join(', ')

        const sql = `CREATE TABLE IF NOT EXISTS ${escapeIdentifier(tableName)} (${columnDefs})`
        await this.dataSource.rpc.executeQuery({ sql, params: [] })
    }

    private async ensureInitialized(): Promise<void> {
        if (!this.dataSource || this.isMetadataInitialized) return
        await this.createMetadataTable()
        await this.loadSyncMetadata()
        this.isMetadataInitialized = true
    }

    private async syncDueTables(): Promise<void> {
        if (!this.dataSource?.external) return

        const now = Date.now()
        for (const sqliteTableName of this.tables.keys()) {
            const meta = this.syncMetadata.get(sqliteTableName)
            const lastAttempt = this.lastSyncAttempt.get(sqliteTableName) || 0
            const lastSyncTs = Math.max(
                meta?.lastSyncTimestamp || 0,
                lastAttempt
            )

            if (lastSyncTs === 0 || now - lastSyncTs >= this.syncInterval) {
                this.lastSyncAttempt.set(sqliteTableName, now)
                try {
                    await this.syncTable(sqliteTableName)
                } catch (error) {
                    console.error(
                        `Background sync failed for table ${sqliteTableName}:`,
                        error
                    )
                }
            }
        }
    }

    override async register(app: StarbaseApp): Promise<void> {
        app.use(async (c, next) => {
            const reqDataSource = c?.get('dataSource')
            const reqConfig = c?.get('config')

            if (reqDataSource) {
                await this.setDataSource(reqDataSource, reqConfig)
            }

            if (this.dataSource && this.autoSync && this.dataSource.external) {
                try {
                    await this.ensureInitialized()

                    const hasUnsyncedTable = Array.from(
                        this.tables.keys()
                    ).some((t) => {
                        const meta = this.syncMetadata.get(t)
                        const lastAttempt = this.lastSyncAttempt.get(t) || 0
                        return !meta?.lastSyncTimestamp && lastAttempt === 0
                    })

                    if (hasUnsyncedTable) {
                        await this.syncDueTables()
                    } else if (this.dataSource.executionContext) {
                        this.dataSource.executionContext.waitUntil(
                            this.syncDueTables()
                        )
                    } else {
                        await this.syncDueTables()
                    }
                } catch (error) {
                    console.error('DataSyncPlugin middleware error:', error)
                }
            }

            await next()
        })

        const statusHandler = async () => {
            const status = {
                config: this.getConfig(),
                tables: Object.fromEntries(this.syncMetadata),
            }
            return createResponse(status, undefined, 200)
        }

        const triggerHandler = async (c: any) => {
            try {
                let targetTable: string | undefined
                try {
                    const body = await c.req.json()
                    targetTable = body?.table
                } catch {
                    // Request body is optional for POST /sync
                }

                if (targetTable) {
                    await this.syncTable(targetTable)
                } else {
                    await this.syncAll()
                }
                return createResponse(
                    {
                        status: 'Sync triggered',
                        tables: Object.fromEntries(this.syncMetadata),
                    },
                    undefined,
                    200
                )
            } catch (error) {
                return createResponse(undefined, (error as Error).message, 500)
            }
        }

        const dataHandler = async () => {
            try {
                const tableData: Record<string, any> = {}
                for (const [sqliteTableName, tableConfig] of this.tables) {
                    const raw = await this.dataSource?.rpc.executeQuery({
                        sql: `SELECT * FROM ${escapeIdentifier(sqliteTableName)} LIMIT 100`,
                        params: [],
                    })
                    const result = normalizeToQueryResult(raw)
                    tableData[tableConfig.name] = {
                        columns: result.columns,
                        rows: result.rows,
                        count: result.rows.length,
                    }
                }
                return createResponse(
                    {
                        tables: tableData,
                        metadata: Object.fromEntries(this.syncMetadata),
                    },
                    undefined,
                    200
                )
            } catch (error) {
                return createResponse(undefined, (error as Error).message, 500)
            }
        }

        app.get('/sync-status', statusHandler)
        app.get(`${this.pathPrefix}/status`, statusHandler)

        app.post('/sync', triggerHandler)
        app.post(`${this.pathPrefix}/trigger`, triggerHandler)

        app.get('/sync-data', dataHandler)
        app.get(`${this.pathPrefix}/data`, dataHandler)

        // If dataSource was already provided before register() (e.g. via setDataSource),
        // validate connection, initialize metadata, and start periodic sync immediately.
        if (this.dataSource) {
            const isValid = await this.syncSource.validateConnection()
            if (!isValid) {
                throw new Error(
                    `Failed to validate connection to external ${this.syncSource.dialect} database`
                )
            }

            await this.createMetadataTable()
            await this.loadSyncMetadata()
            this.isMetadataInitialized = true

            if (this.autoSync) {
                await this.startPeriodicSync()
            }
        }
    }

    public async startPeriodicSync(): Promise<void> {
        if (this.timerId) {
            clearInterval(this.timerId)
            this.timerId = undefined
        }

        await this.syncAll()

        this.timerId = setInterval(async () => {
            await this.syncAll()
        }, this.syncInterval)
    }

    public stopPeriodicSync(): void {
        if (this.timerId) {
            clearInterval(this.timerId)
            this.timerId = undefined
        }
    }

    public async syncTable(tableName: string): Promise<TableSyncResult> {
        if (!this.dataSource) {
            throw new Error('Data source not configured')
        }

        await this.syncSource.setDataSource(
            this.dataSource,
            this.starbaseConfig
        )

        const resolved = this.resolveTableEntry(tableName)
        if (!resolved) {
            throw new Error(
                `Table ${tableName} not found in sync configuration`
            )
        }

        const { sqliteTableName, config: tableConfig } = resolved

        try {
            const validation = await this.syncSource.validateTableStructure(
                tableConfig.name,
                tableConfig
            )
            if (!validation.valid) {
                throw new Error(
                    `Table structure validation failed for ${tableName}: ${validation.errors.join(', ')}`
                )
            }

            const schema = await this.syncSource.getTableSchema(
                tableConfig.name,
                tableConfig.schema
            )

            await this.createTempTable(sqliteTableName, schema, tableConfig)

            const schemaColMap = new Map<string, ColumnDefinition>()
            for (const col of schema) {
                schemaColMap.set(col.name.toLowerCase(), col)
            }

            let cursorCol =
                tableConfig.cursor_column ||
                tableConfig.cursorColumn ||
                tableConfig.track_column ||
                tableConfig.trackColumn
            if (cursorCol && !schemaColMap.has(cursorCol.toLowerCase())) {
                cursorCol = undefined
            } else if (cursorCol) {
                cursorCol = schemaColMap.get(cursorCol.toLowerCase())!.name
            }

            let timestampCol =
                tableConfig.timestamp_column || tableConfig.timestampColumn
            if (timestampCol && !schemaColMap.has(timestampCol.toLowerCase())) {
                const autoTs = schema.find((c) =>
                    ['created_at', 'updated_at'].includes(c.name.toLowerCase())
                )
                timestampCol = autoTs ? autoTs.name : undefined
            } else if (timestampCol) {
                timestampCol = schemaColMap.get(
                    timestampCol.toLowerCase()
                )!.name
            }

            let idCol = tableConfig.id_column || tableConfig.idColumn
            if (idCol && !schemaColMap.has(idCol.toLowerCase())) {
                const autoPk = schema.find((c) => c.primaryKey)
                idCol = autoPk ? autoPk.name : undefined
            } else if (idCol) {
                idCol = schemaColMap.get(idCol.toLowerCase())!.name
            }

            const effectiveConfig: TableSyncConfig = {
                ...tableConfig,
                cursor_column: cursorCol,
                timestamp_column: timestampCol,
                id_column: idCol,
            }

            const existingMetadata = this.syncMetadata.get(sqliteTableName)
            const metadata: TableMetadata = existingMetadata
                ? { ...existingMetadata }
                : { lastSyncTimestamp: 0 }

            const rawNewData = await this.syncSource.getIncrementalData(
                tableConfig.name,
                metadata,
                effectiveConfig
            )
            const newData = normalizeToQueryResult(rawNewData)

            if (newData.rows.length > 0) {
                const insertColumns =
                    newData.columns.length > 0
                        ? newData.columns
                        : schema.map((c) => c.name)
                const columnsList = insertColumns
                    .map((c) => escapeIdentifier(c))
                    .join(', ')
                const placeholders = insertColumns.map(() => '?').join(', ')
                const insertSql = `INSERT OR REPLACE INTO ${escapeIdentifier(sqliteTableName)} (${columnsList}) VALUES (${placeholders})`

                const cursorIdx = cursorCol
                    ? insertColumns.findIndex(
                          (c) => c.toLowerCase() === cursorCol!.toLowerCase()
                      )
                    : -1
                const timestampIdx = timestampCol
                    ? insertColumns.findIndex(
                          (c) => c.toLowerCase() === timestampCol!.toLowerCase()
                      )
                    : -1
                const idIdx = idCol
                    ? insertColumns.findIndex(
                          (c) => c.toLowerCase() === idCol!.toLowerCase()
                      )
                    : -1

                for (const row of newData.rows) {
                    const sanitizedParams = insertColumns.map((_, idx) =>
                        sanitizeSQLiteValue(row[idx])
                    )

                    await this.dataSource.rpc.executeQuery({
                        sql: insertSql,
                        params: sanitizedParams,
                    })

                    if (
                        cursorIdx !== -1 &&
                        row[cursorIdx] !== undefined &&
                        row[cursorIdx] !== null
                    ) {
                        const rawVal = row[cursorIdx]
                        metadata.lastCursorValue =
                            rawVal instanceof Date
                                ? rawVal.toISOString()
                                : rawVal
                        metadata.cursorColumn = cursorCol
                    }

                    if (
                        timestampIdx !== -1 &&
                        row[timestampIdx] !== undefined &&
                        row[timestampIdx] !== null
                    ) {
                        const rawTs = row[timestampIdx]
                        const parsedTs =
                            rawTs instanceof Date
                                ? rawTs.getTime()
                                : new Date(rawTs).getTime()
                        if (!isNaN(parsedTs)) {
                            metadata.lastSyncTimestamp = parsedTs
                        }
                    }

                    if (
                        idIdx !== -1 &&
                        row[idIdx] !== undefined &&
                        row[idIdx] !== null
                    ) {
                        metadata.lastSyncId = row[idIdx]
                    }
                }

                if (!metadata.lastSyncTimestamp) {
                    metadata.lastSyncTimestamp = Date.now()
                }
                metadata.rowsSynced =
                    (metadata.rowsSynced || 0) + newData.rows.length
                metadata.sync_errors = undefined

                await this.updateSyncMetadata(
                    sqliteTableName,
                    metadata,
                    tableConfig.name
                )
            }

            return {
                table: sqliteTableName,
                sourceTable: tableConfig.name,
                rowsSynced: newData.rows.length,
                lastSyncTimestamp: metadata.lastSyncTimestamp,
                lastSyncId: metadata.lastSyncId,
                lastCursorValue: metadata.lastCursorValue,
            }
        } catch (error) {
            const errorMsg = (error as Error).message
            const metadata: TableMetadata = this.syncMetadata.get(
                sqliteTableName
            ) || {
                lastSyncTimestamp: 0,
            }
            metadata.sync_errors = errorMsg
            await this.updateSyncMetadata(
                sqliteTableName,
                metadata,
                tableConfig.name
            )
            throw error
        }
    }

    public async syncAll(): Promise<TableSyncResult[]> {
        const results: TableSyncResult[] = []
        for (const sqliteTableName of this.tables.keys()) {
            try {
                const res = await this.syncTable(sqliteTableName)
                results.push(res)
            } catch (error) {
                console.error(`Failed to sync table ${sqliteTableName}:`, error)
                const cfg = this.tables.get(sqliteTableName)
                results.push({
                    table: sqliteTableName,
                    sourceTable: cfg?.name || sqliteTableName,
                    rowsSynced: 0,
                    lastSyncTimestamp:
                        this.syncMetadata.get(sqliteTableName)
                            ?.lastSyncTimestamp || 0,
                    error: (error as Error).message,
                })
            }
        }
        return results
    }

    public getConfig(): SyncConfig {
        return {
            sync_interval: this.syncInterval / 1000,
            tables: Array.from(this.tables.values()),
            auto_sync: this.autoSync,
        }
    }

    public getMetadata(): Record<string, TableMetadata> {
        return Object.fromEntries(this.syncMetadata)
    }

    override async beforeQuery(opts: {
        sql: string
        params?: unknown[]
        dataSource?: DataSource
        config?: StarbaseDBConfiguration
    }): Promise<{ sql: string; params?: unknown[] }> {
        let { sql, params, dataSource } = opts

        // Only rewrite queries targeting the internal SQLite database
        if (dataSource?.source && dataSource.source !== 'internal') {
            return { sql, params }
        }

        // Never rewrite SQLite system catalog / introspection queries
        if (
            /\b(sqlite_master|sqlite_schema|pragma_table_info|tmp_data_sync_metadata)\b/i.test(
                sql
            ) ||
            /^\s*PRAGMA\b/i.test(sql)
        ) {
            return { sql, params }
        }

        const updatedSql = transformOutsideSingleQuotes(sql, (segment) => {
            let transformed = segment

            // 1. Rewrite configured schema.table references (e.g. analytics.events -> analytics_events, public.users -> users)
            for (const [qualifiedKey, targetTable] of this.schemaTableMap) {
                const [schemaName, tableName] = qualifiedKey.split('.', 2)
                const escapedSchema = schemaName.replace(
                    /[.*+?^${}()|[\]\\]/g,
                    '\\$&'
                )
                const escapedTable = tableName.replace(
                    /[.*+?^${}()|[\]\\]/g,
                    '\\$&'
                )

                // Double-quoted "schema"."table" -> "targetTable"
                const quotedRegex = new RegExp(
                    `"${escapedSchema}"\\s*\\.\\s*"${escapedTable}"`,
                    'gi'
                )
                transformed = transformed.replace(
                    quotedRegex,
                    `"${targetTable}"`
                )

                // Mixed or unquoted schema.table -> targetTable
                const unquotedRegex = new RegExp(
                    `(?:"${escapedSchema}"|\\b${escapedSchema}\\b)\\s*\\.\\s*(?:"${escapedTable}"|\\b${escapedTable}\\b)`,
                    'gi'
                )
                transformed = transformed.replace(unquotedRegex, targetTable)
            }

            // 2. General public.<identifier> prefix omission for internal SQLite queries
            transformed = transformed.replace(
                /"public"\s*\.\s*"([a-zA-Z_][a-zA-Z0-9_]*)"/gi,
                '"$1"'
            )
            transformed = transformed.replace(
                /(?:"public"|\bpublic\b)\s*\.\s*([a-zA-Z_][a-zA-Z0-9_]*)\b/gi,
                '$1'
            )

            // 3. Rewrite standalone table names when an explicit target_table override differs from table.name
            for (const [sqliteTableName, cfg] of this.tables.entries()) {
                if (
                    sqliteTableName !== cfg.name &&
                    (!cfg.schema ||
                        cfg.schema === 'public' ||
                        cfg.schema === 'main')
                ) {
                    const escapedName = cfg.name.replace(
                        /[.*+?^${}()|[\]\\]/g,
                        '\\$&'
                    )
                    const standaloneRegex = new RegExp(
                        `\\b${escapedName}\\b`,
                        'g'
                    )
                    transformed = transformed.replace(
                        standaloneRegex,
                        sqliteTableName
                    )
                }
            }

            return transformed
        })

        return {
            sql: updatedSql,
            params,
        }
    }

    override async afterQuery(opts: {
        sql: string
        result: any
        isRaw: boolean
        dataSource?: DataSource
        config?: StarbaseDBConfiguration
    }): Promise<any> {
        return opts.result
    }
}

export { DataSyncPlugin as ReplicationPlugin }
