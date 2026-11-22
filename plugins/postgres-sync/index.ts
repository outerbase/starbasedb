import {
    ColumnDefinition,
    DatabaseSyncSource,
    escapeIdentifier,
    QueryResult,
    SyncSourceConfig,
    TableMetadata,
    TableSyncConfig,
} from '../data-sync'

export interface PostgresSyncConfig extends SyncSourceConfig {
    dialect: 'postgresql'
    schema?: string
}

/**
 * PostgreSQL Sync Source adapter for replicating schema and data from an external
 * PostgreSQL database (Supabase, Neon, RDS, Hyperdrive, or Outerbase API) into
 * StarbaseDB's internal SQLite database.
 */
export class PostgresSyncSource extends DatabaseSyncSource {
    private schema: string

    constructor(config: Partial<PostgresSyncConfig> = {}) {
        super({
            ...config,
            dialect: 'postgresql',
        })
        this.schema = config.schema || 'public'
    }

    get dialect(): string {
        return 'postgresql'
    }

    async validateConnection(): Promise<boolean> {
        const externalDataSource = this.getExternalDataSource()
        if (
            !externalDataSource ||
            externalDataSource.external?.dialect !== 'postgresql'
        ) {
            return false
        }

        try {
            await this.executeExternalQuery('SELECT version()')
            return true
        } catch (error) {
            console.error('PostgreSQL connection validation failed:', error)
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
            (externalDataSource.external as any)?.defaultSchema ||
            this.schema
        let cleanTableName = tableName.replace(/^tmp_/, '')
        if (cleanTableName.includes('.')) {
            const parts = cleanTableName.split('.', 2)
            targetSchema = schema || parts[0]
            cleanTableName = parts[1]
        }

        const result = await this.executeExternalQuery(
            `SELECT 
                column_name, 
                data_type,
                udt_name,
                is_nullable,
                column_default,
                character_maximum_length
            FROM information_schema.columns 
            WHERE table_schema = ? AND table_name = ?
            ORDER BY ordinal_position`,
            [targetSchema, cleanTableName]
        )

        return (result.rows || []).map((row: any[]) => {
            const colName = String(
                this.getRowValue(row, result.columns, 'column_name', 0)
            )
            const dataType = String(
                this.getRowValue(row, result.columns, 'data_type', 1) || 'text'
            )
            const udtName = this.getRowValue(row, result.columns, 'udt_name', 2)
            const isNullable = this.getRowValue(
                row,
                result.columns,
                'is_nullable',
                3
            )
            const colDefault = this.getRowValue(
                row,
                result.columns,
                'column_default',
                4
            )
            const maxLength = this.getRowValue(
                row,
                result.columns,
                'character_maximum_length',
                5
            )

            let fullType = dataType
            if (
                dataType === 'ARRAY' &&
                typeof udtName === 'string' &&
                udtName.startsWith('_')
            ) {
                fullType = `${udtName.substring(1)}[]`
            } else if (
                dataType === 'USER-DEFINED' &&
                typeof udtName === 'string'
            ) {
                fullType = udtName
            } else if (
                (dataType === 'character varying' || dataType === 'varchar') &&
                maxLength
            ) {
                fullType = `${dataType}(${maxLength})`
            } else if (
                dataType === 'timestamp with time zone' ||
                udtName === 'timestamptz'
            ) {
                fullType = 'timestamp with time zone'
            }

            return {
                name: colName,
                type: fullType,
                nullable:
                    isNullable === 'YES' ||
                    isNullable === true ||
                    isNullable === 1,
                defaultValue: this.normalizeDefaultValue(colDefault, fullType),
            }
        })
    }

    private normalizeDefaultValue(
        defaultValue: string | null | undefined,
        dataType: string
    ): string | undefined {
        if (!defaultValue) return undefined

        if (defaultValue.includes('nextval')) {
            return undefined
        }

        if (defaultValue.includes('(') && defaultValue.includes(')')) {
            return undefined
        }

        if (defaultValue.startsWith("'") && defaultValue.includes("'::")) {
            return defaultValue.split("'::")[0] + "'"
        }

        const baseType = dataType
            .toLowerCase()
            .replace(/\(.*\)/, '')
            .trim()
        if (
            [
                'integer',
                'int',
                'int2',
                'int4',
                'int8',
                'bigint',
                'smallint',
                'numeric',
                'decimal',
                'real',
                'double precision',
            ].includes(baseType)
        ) {
            const num = Number(defaultValue)
            return isNaN(num) ? undefined : String(num)
        }

        return defaultValue
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

        let targetSchema =
            tableConfig.schema ||
            (externalDataSource.external as any)?.defaultSchema ||
            this.schema
        let sourceTable = tableConfig.name || tableName.replace(/^tmp_/, '')
        if (sourceTable.includes('.')) {
            const parts = sourceTable.split('.', 2)
            targetSchema = tableConfig.schema || parts[0]
            sourceTable = parts[1]
        }

        const cursorCol =
            tableConfig.cursor_column ||
            tableConfig.cursorColumn ||
            tableConfig.track_column ||
            tableConfig.trackColumn
        const timestampCol =
            tableConfig.timestamp_column || tableConfig.timestampColumn
        const idCol = tableConfig.id_column || tableConfig.idColumn

        let query = `SELECT * FROM ${escapeIdentifier(targetSchema)}.${escapeIdentifier(sourceTable)}`
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

    mapDataType(postgresType: string): string {
        if (postgresType.endsWith('[]')) {
            return 'TEXT'
        }

        const baseType = postgresType
            .toLowerCase()
            .replace(/\(.*\)/, '')
            .trim()

        const typeMap: Record<string, string> = {
            integer: 'INTEGER',
            int: 'INTEGER',
            int2: 'INTEGER',
            int4: 'INTEGER',
            int8: 'INTEGER',
            bigint: 'INTEGER',
            smallint: 'INTEGER',
            serial: 'INTEGER',
            bigserial: 'INTEGER',
            smallserial: 'INTEGER',
            numeric: 'REAL',
            decimal: 'REAL',
            real: 'REAL',
            'double precision': 'REAL',
            float: 'REAL',
            float4: 'REAL',
            float8: 'REAL',
            money: 'REAL',
            'character varying': 'TEXT',
            varchar: 'TEXT',
            character: 'TEXT',
            char: 'TEXT',
            text: 'TEXT',
            bytea: 'BLOB',
            date: 'TEXT',
            time: 'TEXT',
            'time without time zone': 'TEXT',
            'time with time zone': 'TEXT',
            timetz: 'TEXT',
            timestamp: 'TEXT',
            'timestamp with time zone': 'TEXT',
            'timestamp without time zone': 'TEXT',
            timestamptz: 'TEXT',
            interval: 'TEXT',
            boolean: 'INTEGER',
            bool: 'INTEGER',
            json: 'TEXT',
            jsonb: 'TEXT',
            uuid: 'TEXT',
            point: 'TEXT',
            line: 'TEXT',
            lseg: 'TEXT',
            box: 'TEXT',
            path: 'TEXT',
            polygon: 'TEXT',
            circle: 'TEXT',
            cidr: 'TEXT',
            inet: 'TEXT',
            macaddr: 'TEXT',
            macaddr8: 'TEXT',
            bit: 'INTEGER',
            'bit varying': 'INTEGER',
            xml: 'TEXT',
            tsvector: 'TEXT',
            tsquery: 'TEXT',
        }

        return typeMap[baseType] || 'TEXT'
    }

    async validateTableStructure(
        tableName: string,
        tableConfig: TableSyncConfig
    ): Promise<{ valid: boolean; errors: string[] }> {
        const externalDataSource = this.getExternalDataSource()
        if (!externalDataSource) {
            throw new Error('External data source not configured')
        }

        let targetSchema =
            tableConfig.schema ||
            (externalDataSource.external as any)?.defaultSchema ||
            this.schema
        let sourceTableName = tableConfig.name || tableName.replace(/^tmp_/, '')
        if (sourceTableName.includes('.')) {
            const parts = sourceTableName.split('.', 2)
            targetSchema = tableConfig.schema || parts[0]
            sourceTableName = parts[1]
        }

        const errors: string[] = []

        const tableExists = await this.executeExternalQuery(
            `SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_schema = ? 
                AND table_name = ?
            )`,
            [targetSchema, sourceTableName]
        )

        const existsVal = tableExists.rows?.[0]?.[0]
        const isExisting =
            existsVal === true ||
            existsVal === 't' ||
            existsVal === 'true' ||
            existsVal === 1 ||
            existsVal === '1'

        if (!tableExists.rows?.length || !isExisting) {
            return {
                valid: false,
                errors: [
                    `Table ${targetSchema}.${sourceTableName} does not exist`,
                ],
            }
        }

        const columns = await this.getTableSchema(sourceTableName, targetSchema)

        // When a table is configured by string name without explicit sync columns,
        // do not fail validation if default created_at or id columns are absent.
        if (tableConfig.hasExplicitSyncColumns === false) {
            return {
                valid: true,
                errors: [],
            }
        }

        const cursorColName =
            tableConfig.cursor_column ||
            tableConfig.cursorColumn ||
            tableConfig.track_column ||
            tableConfig.trackColumn
        if (
            cursorColName &&
            (tableConfig as any).explicitCursorColumn !== false
        ) {
            const cursorCol = columns.find((col) => col.name === cursorColName)
            if (!cursorCol) {
                errors.push(
                    `Cursor column ${cursorColName} not found in table ${targetSchema}.${sourceTableName}`
                )
            }
        }

        const tsColName =
            tableConfig.timestamp_column || tableConfig.timestampColumn
        if (
            tsColName &&
            (tableConfig as any).explicitTimestampColumn !== false
        ) {
            const timestampCol = columns.find((col) => col.name === tsColName)
            if (!timestampCol) {
                errors.push(
                    `Timestamp column ${tsColName} not found in table ${targetSchema}.${sourceTableName}`
                )
            } else if (!this.isTimestampType(timestampCol.type)) {
                errors.push(
                    `Column ${tsColName} in table ${targetSchema}.${sourceTableName} is not a timestamp type (found: ${timestampCol.type})`
                )
            }
        }

        const idColName = tableConfig.id_column || tableConfig.idColumn
        if (idColName && (tableConfig as any).explicitIdColumn !== false) {
            const idCol = columns.find((col) => col.name === idColName)
            if (!idCol) {
                errors.push(
                    `ID column ${idColName} not found in table ${targetSchema}.${sourceTableName}`
                )
            }
        }

        return {
            valid: errors.length === 0,
            errors,
        }
    }

    private isTimestampType(type: string): boolean {
        const normalized = type.toLowerCase().trim()
        const timestampTypes = [
            'timestamp',
            'timestamp with time zone',
            'timestamp without time zone',
            'timestamptz',
            'date',
            'time',
            'time with time zone',
            'time without time zone',
            'datetime',
        ]
        return (
            timestampTypes.includes(normalized) ||
            normalized.startsWith('timestamp')
        )
    }
}

export { PostgresSyncSource as PostgresSync }
