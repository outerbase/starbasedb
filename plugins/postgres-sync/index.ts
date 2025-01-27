import {
    DatabaseSyncSource,
    QueryResult,
    TableMetadata,
    ColumnDefinition,
    SyncSourceConfig,
    TableSyncConfig,
} from '../data-sync'

export interface PostgresSyncConfig extends SyncSourceConfig {
    dialect: 'postgresql'
    schema?: string
}

export class PostgresSyncSource extends DatabaseSyncSource {
    private schema: string

    constructor(config: PostgresSyncConfig) {
        super(config)
        this.schema = config.schema || 'public'
    }

    get dialect(): string {
        return 'postgresql'
    }

    override async validateConnection(): Promise<boolean> {
        const dataSource = this.getExternalDataSource()
        if (!dataSource?.external) {
            console.error(
                'PostgresSyncSource: No external database connection available',
                {
                    hasDataSource: !!this.dataSource,
                    hasExternal: !!this.dataSource?.external,
                }
            )
            return false
        }

        // Check if it's PostgreSQL
        if (dataSource.external.dialect !== 'postgresql') {
            console.error('PostgresSyncSource: Database is not PostgreSQL:', {
                dialect: dataSource.external.dialect,
                hasDataSource: !!this.dataSource,
                hasExternal: !!this.dataSource?.external,
            })
            return false
        }

        try {
            const result = await dataSource.rpc.executeQuery({
                sql: 'SELECT version()',
                params: [],
            })
            console.log('PostgreSQL connection validated:', result)
            return true
        } catch (error) {
            console.error('PostgreSQL connection failed:', error)
            return false
        }
    }

    async getTableSchema(tableName: string): Promise<ColumnDefinition[]> {
        const dataSource = this.getExternalDataSource()
        if (
            !dataSource?.external ||
            dataSource.external.dialect !== 'postgresql'
        ) {
            console.error(
                'PostgresSyncSource: Cannot get table schema - invalid dataSource',
                {
                    hasDataSource: !!this.dataSource,
                    hasExternal: !!this.dataSource?.external,
                    dialect: this.dataSource?.external?.dialect,
                }
            )
            return []
        }

        try {
            const result = (await dataSource.rpc.executeQuery({
                sql: `
                    SELECT 
                        column_name, 
                        data_type,
                        udt_name,
                        is_nullable = 'YES' as is_nullable,
                        column_default,
                        character_maximum_length
                    FROM information_schema.columns 
                    WHERE table_schema = ? AND table_name = ?
                    ORDER BY ordinal_position
                `,
                params: [this.schema, tableName],
            })) as QueryResult

            return result.rows.map((row) => ({
                name: row[0] as string,
                type: this.normalizePostgresType(
                    row[1] as string,
                    row[2] as string,
                    row[5] as number
                ),
                nullable: row[3] as boolean,
                defaultValue: this.normalizeDefaultValue(row[4] as string),
            }))
        } catch (error) {
            console.error(
                `PostgresSyncSource: Error getting schema for table ${tableName}:`,
                error
            )
            return []
        }
    }

    private normalizePostgresType(
        dataType: string,
        udtName: string,
        maxLength?: number
    ): string {
        // Handle array types
        if (udtName.startsWith('_')) {
            return `${udtName.slice(1)}[]`
        }

        // Handle varchar/char with length
        if (
            (dataType === 'character varying' || dataType === 'character') &&
            maxLength
        ) {
            return `${dataType}(${maxLength})`
        }

        // Handle special types
        switch (udtName) {
            case 'timestamptz':
                return 'timestamp with time zone'
            case 'timestamp':
                return 'timestamp without time zone'
            default:
                return dataType
        }
    }

    private normalizeDefaultValue(
        defaultValue: string | null
    ): string | undefined {
        if (!defaultValue) return undefined

        // Handle sequence defaults
        if (defaultValue.includes('nextval')) {
            return undefined // Let SQLite handle auto-increment
        }

        // Remove type casting
        const valueMatch = defaultValue.match(/'([^']*)'/)
        if (valueMatch) {
            return valueMatch[1]
        }

        return defaultValue
    }

    async getIncrementalData(
        tableName: string,
        lastSync: TableMetadata,
        tableConfig: TableSyncConfig
    ): Promise<QueryResult> {
        const dataSource = this.getExternalDataSource()
        if (
            !dataSource?.external ||
            dataSource.external.dialect !== 'postgresql'
        ) {
            console.error(
                'PostgresSyncSource: Cannot get incremental data - invalid dataSource',
                {
                    hasDataSource: !!this.dataSource,
                    hasExternal: !!this.dataSource?.external,
                    dialect: this.dataSource?.external?.dialect,
                }
            )
            return { rows: [], columns: [] }
        }

        try {
            const timestampColumn = tableConfig.timestamp_column || 'created_at'
            const idColumn = tableConfig.id_column || 'id'
            const batchSize = tableConfig.batch_size || 1000

            let query = `SELECT * FROM ${this.schema}.${tableName}`
            const params: any[] = []

            // Build WHERE clause based on available sync columns
            const conditions: string[] = []

            if (lastSync.lastSyncTimestamp && timestampColumn) {
                conditions.push(`${timestampColumn} > ?`)
                params.push(new Date(lastSync.lastSyncTimestamp).toISOString())
            }

            if (lastSync.lastSyncId && idColumn) {
                conditions.push(`${idColumn} > ?`)
                params.push(lastSync.lastSyncId.toString())
            }

            if (conditions.length > 0) {
                query += ` WHERE ${conditions.join(' OR ')}`
            }

            // Order by configured columns
            const orderBy: string[] = []
            if (timestampColumn) orderBy.push(timestampColumn)
            if (idColumn && idColumn !== timestampColumn) orderBy.push(idColumn)

            if (orderBy.length > 0) {
                query += ` ORDER BY ${orderBy.join(', ')} ASC`
            }

            query += ` LIMIT ${batchSize}`

            return (await dataSource.rpc.executeQuery({
                sql: query,
                params,
            })) as QueryResult
        } catch (error) {
            console.error(
                `PostgresSyncSource: Error getting incremental data for table ${tableName}:`,
                error
            )
            return { rows: [], columns: [] }
        }
    }

    mapDataType(pgType: string): string {
        // Map PostgreSQL types to SQLite types
        const typeMap: { [key: string]: string } = {
            integer: 'INTEGER',
            bigint: 'INTEGER',
            smallint: 'INTEGER',
            text: 'TEXT',
            varchar: 'TEXT',
            'character varying': 'TEXT',
            char: 'TEXT',
            character: 'TEXT',
            boolean: 'INTEGER',
            date: 'TEXT',
            timestamp: 'TEXT',
            'timestamp with time zone': 'TEXT',
            'timestamp without time zone': 'TEXT',
            numeric: 'REAL',
            decimal: 'REAL',
            real: 'REAL',
            'double precision': 'REAL',
            json: 'TEXT',
            jsonb: 'TEXT',
            uuid: 'TEXT',
            bytea: 'BLOB',
            interval: 'TEXT',
            point: 'TEXT',
            line: 'TEXT',
            polygon: 'TEXT',
            cidr: 'TEXT',
            inet: 'TEXT',
            macaddr: 'TEXT',
            bit: 'INTEGER',
            'bit varying': 'INTEGER',
            money: 'REAL',
            xml: 'TEXT',
        }

        // Handle array types
        if (pgType.endsWith('[]')) {
            return 'TEXT' // Store arrays as JSON text in SQLite
        }

        return typeMap[pgType.toLowerCase()] || 'TEXT'
    }

    async validateTableStructure(
        tableName: string,
        tableConfig: TableSyncConfig
    ): Promise<{ valid: boolean; errors: string[] }> {
        const dataSource = this.getExternalDataSource()
        if (!dataSource?.external) {
            return {
                valid: false,
                errors: ['External database connection not available'],
            }
        }

        const errors: string[] = []
        try {
            // Check if table exists
            const tableExists = (await dataSource.rpc.executeQuery({
                sql: `
                    SELECT EXISTS (
                        SELECT FROM information_schema.tables 
                        WHERE table_schema = ? AND table_name = ?
                    )
                `,
                params: [this.schema, tableName],
            })) as QueryResult

            if (!tableExists.rows[0][0]) {
                errors.push(
                    `Table '${tableName}' does not exist in schema '${this.schema}'`
                )
                return { valid: false, errors }
            }

            // Check configured sync columns exist and have appropriate types
            const columns = await this.getTableSchema(tableName)
            const columnMap = new Map(columns.map((col) => [col.name, col]))

            if (tableConfig.timestamp_column) {
                const col = columnMap.get(tableConfig.timestamp_column)
                if (!col) {
                    errors.push(
                        `Configured timestamp column '${tableConfig.timestamp_column}' missing from table '${tableName}'`
                    )
                } else if (!this.isTimestampType(col.type)) {
                    errors.push(
                        `Column '${tableConfig.timestamp_column}' is not a timestamp type (found: ${col.type})`
                    )
                }
            }

            if (tableConfig.id_column) {
                const col = columnMap.get(tableConfig.id_column)
                if (!col) {
                    errors.push(
                        `Configured ID column '${tableConfig.id_column}' missing from table '${tableName}'`
                    )
                }
            }

            // If no sync columns are configured, require at least one
            if (!tableConfig.timestamp_column && !tableConfig.id_column) {
                errors.push(
                    `No sync columns configured for table '${tableName}'. At least one of timestamp_column or id_column is required.`
                )
            }

            return {
                valid: errors.length === 0,
                errors,
            }
        } catch (error) {
            console.error(
                `PostgresSyncSource: Error validating table structure for '${tableName}':`,
                error
            )
            return {
                valid: false,
                errors: [(error as Error).message],
            }
        }
    }

    private isTimestampType(type: string): boolean {
        return [
            'timestamp',
            'timestamp with time zone',
            'timestamp without time zone',
            'date',
            'timestamptz',
        ].includes(type.toLowerCase())
    }
}
