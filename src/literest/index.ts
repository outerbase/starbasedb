import { createResponse } from '../utils'
import { DataSource } from '../types'
import { executeQuery, executeTransaction } from '../operation'
import { StarbaseDBConfiguration } from '../handler'

export class LiteREST {
    private dataSource: DataSource
    private config: StarbaseDBConfiguration

    constructor(dataSource: DataSource, config: StarbaseDBConfiguration) {
        this.dataSource = dataSource
        this.config = config
    }

    /**
     * Sanitizes an identifier by removing all non-alphanumeric characters except underscores.
     * @param identifier - The identifier to sanitize.
     * @returns The sanitized identifier.
     */
    private sanitizeIdentifier(identifier: string): string {
        return identifier.replace(/[^a-zA-Z0-9_]/g, '')
    }

    /**
     * Retrieves the primary key columns for a given table.
     * @param tableName - The name of the table.
     * @returns An array of primary key column names.
     */
    private async getPrimaryKeyColumns(
        tableName: string,
        schemaName?: string
    ): Promise<string[]> {
        let query = `PRAGMA table_info(${tableName});`

        if (this.dataSource.source === 'external') {
            if (this.dataSource.external?.dialect === 'postgresql') {
                query = `
                    SELECT kcu.column_name AS name 
                    FROM information_schema.table_constraints tc 
                    JOIN information_schema.key_column_usage kcu 
                    ON tc.constraint_name = kcu.constraint_name
                    AND tc.table_schema = kcu.table_schema 
                    AND tc.table_name = kcu.table_name 
                    WHERE tc.constraint_type = 'PRIMARY KEY'
                    AND tc.table_name = '${tableName}' 
                    AND tc.table_schema = '${schemaName ?? 'public'}';`
            } else if (this.dataSource.external?.dialect === 'mysql') {
                query = `
                    SELECT COLUMN_NAME AS name FROM information_schema.key_column_usage 
                    WHERE table_name = '${tableName}' 
                    AND constraint_name = 'PRIMARY'
                    AND table_schema = ${schemaName ?? 'DATABASE()'};
                `
            }
        }

        const isSQLite =
            this.dataSource.source === 'internal' ||
            this.dataSource.external?.dialect === 'sqlite'

        const schemaInfo = (await executeQuery({
            sql: query,
            params: [],
            isRaw: false,
            dataSource: this.dataSource,
            config: this.config,
        })) as any[]

        let pkColumns = []

        if (isSQLite) {
            pkColumns = schemaInfo
                .filter(
                    (col) =>
                        typeof col.pk === 'number' &&
                        col.pk > 0 &&
                        col.name !== null
                )
                .map((col) => col.name as string)
        } else {
            pkColumns = schemaInfo.map((col) => col.name as string)
        }

        return pkColumns
    }

    /**
     * Checks if the provided data is valid.
     * @param data - The data to validate.
     * @returns True if the data is valid, false otherwise.
     */
    private isDataValid(data: any): boolean {
        return data && typeof data === 'object' && !Array.isArray(data)
    }

    /**
     * Sanitizes an operator by mapping it to a valid SQL operator.
     * @param operator - The operator to sanitize.
     * @returns The sanitized operator.
     */
    private sanitizeOperator(operator: string | undefined): string {
        const allowedOperators: { [key: string]: string } = {
            eq: '=',
            ne: '!=',
            gt: '>',
            lt: '<',
            gte: '>=',
            lte: '<=',
            like: 'LIKE',
            in: 'IN',
        }
        return allowedOperators[operator || 'eq'] || '='
    }

    /**
     * Retrieves the primary key conditions for a given table.
     * @param pkColumns - The primary key columns for the table.
     * @param id - The identifier for the record.
     * @param data - The data to use for primary key conditions.
     * @param searchParams - The search parameters.
     * @returns An object containing the conditions, parameters, and any error message.
     */
    private getPrimaryKeyConditions(
        pkColumns: string[],
        id: string | undefined,
        data: any,
        searchParams: URLSearchParams
    ): { conditions: string[]; params: any[]; error?: string } {
        const conditions: string[] = []
        const params: any[] = []

        if (pkColumns?.length === 1) {
            const pk = pkColumns[0]
            const pkValue = id || data[pk] || searchParams.get(pk)
            if (!pkValue) {
                return {
                    conditions,
                    params,
                    error: `Missing primary key value for '${pk}'`,
                }
            }
            conditions.push(`${pk} = ?`)
            params.push(pkValue)
        } else {
            // Composite primary key
            for (const pk of pkColumns) {
                const pkValue = data[pk] || searchParams.get(pk)
                if (!pkValue) {
                    return {
                        conditions,
                        params,
                        error: `Missing primary key value for '${pk}'`,
                    }
                }
                conditions.push(`${pk} = ?`)
                params.push(pkValue)
            }
        }

        return { conditions, params }
    }

    /**
     * Executes a set of operations.
     * @param queries - The operations to execute.
     */
    private async executeOperation(
        queries: { sql: string; params: any[] }[]
    ): Promise<{ result?: any; error?: string | undefined; status: number }> {
        const results: any[] = (await executeTransaction({
            queries,
            isRaw: false,
            dataSource: this.dataSource,
            config: this.config,
        })) as any[]
        return {
            result: results?.length > 0 ? results[0] : undefined,
            status: 200,
        }
    }

    /**
     * Handles the incoming request and determines the appropriate action based on the method and path.
     * @param request - The incoming request.
     * @returns The response to the request.
     */
    async handleRequest(request: Request): Promise<Response> {
        const { method, tableName, schemaName, id, searchParams, body } =
            await this.parseRequest(request)

        try {
            switch (method) {
                case 'GET':
                    return await this.handleGet(
                        tableName,
                        schemaName,
                        id,
                        searchParams
                    )
                case 'POST':
                    return await this.handlePost(tableName, schemaName, body)
                case 'PATCH':
                    return await this.handlePatch(
                        tableName,
                        schemaName,
                        id,
                        body
                    )
                case 'PUT':
                    return await this.handlePut(tableName, schemaName, id, body)
                case 'DELETE':
                    return await this.handleDelete(tableName, schemaName, id)
                default:
                    return createResponse(undefined, 'Method not allowed', 405)
            }
        } catch (error: any) {
            console.error('LiteREST Error:', error)
            return createResponse(
                undefined,
                error.message || 'An unexpected error occurred',
                500
            )
        }
    }

    /**
     * Parses the incoming request and extracts the method, table name, id, search parameters, and body.
     * @param request - The incoming request.
     * @returns An object containing the method, table name, id, search parameters, and body.
     */
    private async parseRequest(request: Request): Promise<{
        method: string
        tableName: string
        schemaName: string | undefined
        id?: string
        searchParams: URLSearchParams
        body?: any
    }> {
        const liteRequest = new Request(
            request.url.replace('/rest', ''),
            request
        )
        const url = new URL(liteRequest.url)
        const pathParts = url.pathname.split('/').filter(Boolean)

        if (pathParts.length === 0) {
            throw new Error('Expected a table name in the path')
        }

        const tableName = this.sanitizeIdentifier(
            pathParts.length === 1 ? pathParts[0] : pathParts[1]
        )
        const schemaName = this.sanitizeIdentifier(pathParts[0])
        const id = pathParts.length === 3 ? pathParts[2] : undefined
        const body = ['POST', 'PUT', 'PATCH'].includes(liteRequest.method)
            ? await liteRequest.json()
            : undefined

        return {
            method: liteRequest.method,
            tableName,
            schemaName,
            id,
            searchParams: url.searchParams,
            body,
        }
    }

    private async buildSelectQuery(
        tableName: string,
        schemaName: string | undefined,
        id: string | undefined,
        searchParams: URLSearchParams
    ): Promise<{ query: string; params: any[] }> {
        let query = `SELECT * FROM ${
            schemaName ? `${schemaName}.` : ''
        }${tableName}`
        const params: any[] = []
        const conditions: string[] = []
        const pkColumns = await this.getPrimaryKeyColumns(tableName, schemaName)
        const {
            conditions: pkConditions,
            params: pkParams,
            error,
        } = this.getPrimaryKeyConditions(pkColumns, id, {}, searchParams)

        if (!error) {
            conditions.push(...pkConditions)
            params.push(...pkParams)
        }

        // Extract special parameters
        const sortBy = searchParams.get('sort_by')
        const orderParam = searchParams.get('order')
        const limitParam = searchParams.get('limit')
        const offsetParam = searchParams.get('offset')

        // Remove special parameters from searchParams
        ;['sort_by', 'order', 'limit', 'offset'].forEach((param) =>
            searchParams.delete(param)
        )

        // Handle other search parameters
        for (const [key, value] of searchParams.entries()) {
            if (pkColumns.includes(key)) continue // Skip primary key columns
            const [column, op] = key.split('.')
            const sanitizedColumn = this.sanitizeIdentifier(column)
            const operator = this.sanitizeOperator(op)

            if (operator === 'IN') {
                const values = value.split(',').map((val) => val.trim())
                const placeholders = values.map(() => '?').join(', ')
                conditions.push(`${sanitizedColumn} IN (${placeholders})`)
                params.push(...values)
            } else {
                conditions.push(`${sanitizedColumn} ${operator} ?`)
                params.push(value)
            }
        }

        // Add WHERE clause if there are conditions
        if (conditions.length > 0) {
            query += ` WHERE ${conditions.join(' AND ')}`
        }

        // Add ORDER BY clause
        if (sortBy) {
            const sanitizedSortBy = this.sanitizeIdentifier(sortBy)
            const order = orderParam?.toUpperCase() === 'DESC' ? 'DESC' : 'ASC'
            query += ` ORDER BY ${sanitizedSortBy} ${order}`
        }

        // Add LIMIT and OFFSET clauses
        if (limitParam) {
            const limit = parseInt(limitParam, 10)
            if (limit > 0) {
                query += ` LIMIT ?`
                params.push(limit)

                if (offsetParam) {
                    const offset = parseInt(offsetParam, 10)
                    if (offset > 0) {
                        query += ` OFFSET ?`
                        params.push(offset)
                    }
                }
            }
        }

        return { query, params }
    }

    private async handleGet(
        tableName: string,
        schemaName: string | undefined,
        id: string | undefined,
        searchParams: URLSearchParams
    ): Promise<Response> {
        const { query, params } = await this.buildSelectQuery(
            tableName,
            schemaName,
            id,
            searchParams
        )

        try {
            const response = await this.executeOperation([
                { sql: query, params },
            ])
            let resultData = response.result
            if (!Array.isArray(resultData)) {
                resultData = [resultData]
            }
            return createResponse(resultData, undefined, 200)
        } catch (error: any) {
            console.error('GET Operation Error:', error)
            return createResponse(
                undefined,
                error.message || 'Failed to retrieve data',
                500
            )
        }
    }

    private async handlePost(
        tableName: string,
        schemaName: string | undefined,
        data: any
    ): Promise<Response> {
        if (!this.isDataValid(data)) {
            console.error('Invalid data format for POST:', data)
            return createResponse(undefined, 'Invalid data format', 400)
        }

        const dataKeys = Object.keys(data)
        if (dataKeys.length === 0) {
            console.error('No data provided for POST')
            return createResponse(undefined, 'No data provided', 400)
        }

        // Sanitize column names
        const columns = dataKeys.map((col) => this.sanitizeIdentifier(col))
        const placeholders = columns.map(() => '?').join(', ')
        const query = `INSERT INTO ${
            schemaName ? `${schemaName}.` : ''
        }${tableName} (${columns.join(', ')}) VALUES (${placeholders})`

        // Map parameters using original data keys to get correct values
        const params = dataKeys.map((key) => data[key])
        const queries = [{ sql: query, params }]

        try {
            await this.executeOperation(queries)
            return createResponse(
                { message: 'Resource created successfully', data },
                undefined,
                201
            )
        } catch (error: any) {
            console.error('POST Operation Error:', error)
            const errorMessage =
                error.message ||
                error.error ||
                JSON.stringify(error) ||
                'Failed to create resource'
            return createResponse(undefined, errorMessage, 500)
        }
    }

    private async handlePatch(
        tableName: string,
        schemaName: string | undefined,
        id: string | undefined,
        data: any
    ): Promise<Response> {
        const pkColumns = await this.getPrimaryKeyColumns(tableName, schemaName)

        const {
            conditions: pkConditions,
            params: pkParams,
            error,
        } = this.getPrimaryKeyConditions(
            pkColumns,
            id,
            data,
            new URLSearchParams()
        )

        if (error) {
            console.error('PATCH Operation Error:', error)
            return createResponse(undefined, error, 400)
        }

        if (!this.isDataValid(data)) {
            console.error('Invalid data format for PATCH:', data)
            return createResponse(undefined, 'Invalid data format', 400)
        }

        const dataKeys = Object.keys(data)
        if (dataKeys.length === 0) {
            console.error('No data provided for PATCH')
            return createResponse(undefined, 'No data provided', 400)
        }

        // Remove primary key columns from dataKeys
        const updateKeys = dataKeys.filter((key) => !pkColumns.includes(key))

        if (updateKeys.length === 0) {
            console.error('No updatable data provided for PATCH')
            return createResponse(undefined, 'No updatable data provided', 400)
        }

        // Sanitize column names
        const columns = updateKeys.map((col) => this.sanitizeIdentifier(col))
        const setClause = columns.map((col) => `${col} = ?`).join(', ')
        const query = `UPDATE ${
            schemaName ? `${schemaName}.` : ''
        }${tableName} SET ${setClause} WHERE ${pkConditions.join(' AND ')}`

        // Map parameters using original data keys to get correct values
        const params = updateKeys.map((key) => data[key])
        params.push(...pkParams)

        const queries = [{ sql: query, params }]

        try {
            await this.executeOperation(queries)
            return createResponse(
                { message: 'Resource updated successfully', data },
                undefined,
                200
            )
        } catch (error: any) {
            console.error('PATCH Operation Error:', error)
            return createResponse(
                undefined,
                error.message || 'Failed to update resource',
                500
            )
        }
    }

    private async handlePut(
        tableName: string,
        schemaName: string | undefined,
        id: string | undefined,
        data: any
    ): Promise<Response> {
        const pkColumns = await this.getPrimaryKeyColumns(tableName, schemaName)

        const {
            conditions: pkConditions,
            params: pkParams,
            error,
        } = this.getPrimaryKeyConditions(
            pkColumns,
            id,
            data,
            new URLSearchParams()
        )

        if (error) {
            console.error('PUT Operation Error:', error)
            return createResponse(undefined, error, 400)
        }

        if (!this.isDataValid(data)) {
            console.error('Invalid data format for PUT:', data)
            return createResponse(undefined, 'Invalid data format', 400)
        }

        const dataKeys = Object.keys(data)
        if (dataKeys.length === 0) {
            console.error('No data provided for PUT')
            return createResponse(undefined, 'No data provided', 400)
        }

        // Sanitize column names
        const columns = dataKeys.map((col) => this.sanitizeIdentifier(col))
        const setClause = columns.map((col) => `${col} = ?`).join(', ')
        const query = `UPDATE ${
            schemaName ? `${schemaName}.` : ''
        }${tableName} SET ${setClause} WHERE ${pkConditions.join(' AND ')}`

        // Map parameters using original data keys to get correct values
        const params = dataKeys.map((key) => data[key])
        params.push(...pkParams)

        const queries = [{ sql: query, params }]

        try {
            await this.executeOperation(queries)
            return createResponse(
                { message: 'Resource replaced successfully', data },
                undefined,
                200
            )
        } catch (error: any) {
            console.error('PUT Operation Error:', error)
            return createResponse(
                undefined,
                error.message || 'Failed to replace resource',
                500
            )
        }
    }

    private async handleDelete(
        tableName: string,
        schemaName: string | undefined,
        id: string | undefined
    ): Promise<Response> {
        console.log(`Executing DELETE on table: ${tableName}, ID: ${id}`)

        const pkColumns = await this.getPrimaryKeyColumns(tableName, schemaName)
        console.log('Primary Key Columns:', pkColumns)

        let data: any = {}

        if (!id) {
            console.error('DELETE Error: Missing primary key value for ID')
            return createResponse(
                undefined,
                "Missing primary key value for 'id'",
                400
            )
        }

        if (!pkColumns.length) {
            console.error('DELETE Error: No primary key found for table')
            return createResponse(
                undefined,
                `No primary key found for table '${tableName}'`,
                400
            )
        }

        // Currently the DELETE only works with single primary key tables.
        if (pkColumns.length) {
            const firstPK = pkColumns[0]
            data[firstPK] = id
        }

        const {
            conditions: pkConditions,
            params: pkParams,
            error,
        } = this.getPrimaryKeyConditions(
            pkColumns,
            id,
            data,
            new URLSearchParams()
        )

        if (error) {
            console.error('DELETE Operation Error:', error)
            return createResponse(undefined, error, 400)
        }

        const query = `DELETE FROM ${
            schemaName ? `${schemaName}.` : ''
        }${tableName} WHERE ${pkConditions.join(' AND ')}`

        console.log('Final DELETE Query:', query, 'Params:', pkParams)
        const queries = [{ sql: query, params: pkParams }]

        try {
            const result = await this.executeOperation(queries)
            console.log('DELETE Operation Result:', result)

            return createResponse(
                { message: 'Resource deleted successfully' },
                undefined,
                200
            )
        } catch (error: any) {
            console.error('DELETE Operation Error:', error)
            return createResponse(
                undefined,
                error.message || 'Failed to delete resource',
                500
            )
        }
    }
}
