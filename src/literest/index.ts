import { createResponse } from '../utils'
import { DataSource } from '../types'
import { executeQuery, executeTransaction } from '../operation'
import { StarbaseDBConfiguration } from '../handler'

const ALLOWED_OPERATORS: Record<string, string> = {
    eq: '=',
    ne: '!=',
    gt: '>',
    lt: '<',
    gte: '>=',
    lte: '<=',
    like: 'LIKE',
    in: 'IN',
}

const RESERVED_SEARCH_PARAMS = ['sort_by', 'order', 'limit', 'offset']

type TableRef = {
    tableName: string
    schemaName?: string
    id?: string
}

type ParsedRestRequest = TableRef & {
    method: string
    searchParams: URLSearchParams
    body?: any
}

function qualifyTable(ref: TableRef): string {
    return ref.schemaName ? `${ref.schemaName}.${ref.tableName}` : ref.tableName
}

function buildPostgresPrimaryKeyQuery(ref: TableRef): string {
    return `
                    SELECT kcu.column_name AS name 
                    FROM information_schema.table_constraints tc 
                    JOIN information_schema.key_column_usage kcu 
                    ON tc.constraint_name = kcu.constraint_name
                    AND tc.table_schema = kcu.table_schema 
                    AND tc.table_name = kcu.table_name 
                    WHERE tc.constraint_type = 'PRIMARY KEY'
                    AND tc.table_name = '${ref.tableName}' 
                    AND tc.table_schema = '${ref.schemaName ?? 'public'}';`
}

function buildMysqlPrimaryKeyQuery(ref: TableRef): string {
    return `
                    SELECT COLUMN_NAME AS name FROM information_schema.key_column_usage 
                    WHERE table_name = '${ref.tableName}' 
                    AND constraint_name = 'PRIMARY'
                    AND table_schema = ${ref.schemaName ?? 'DATABASE()'};
                `
}

function extractSqlitePkNames(schemaInfo: any[]): string[] {
    return schemaInfo
        .filter((col) => Number(col?.pk) > 0 && col?.name !== null)
        .map((col) => col.name as string)
}

export class LiteREST {
    private dataSource: DataSource
    private config: StarbaseDBConfiguration

    constructor(dataSource: DataSource, config: StarbaseDBConfiguration) {
        this.dataSource = dataSource
        this.config = config
    }

    /**
     * Determines whether REST CRUD operations bypass SQL allowlist enforcement.
     */
    private shouldBypassAllowlist(): boolean {
        return this.config?.features?.allowlistBypassRest ?? true
    }

    /**
     * Strips non-alphanumeric characters other than underscores from SQL identifiers.
     */
    private sanitizeIdentifier(identifier: string): string {
        return identifier.replace(/[^a-zA-Z0-9_]/g, '')
    }

    private resolveDialect(): 'postgresql' | 'mysql' | 'sqlite' {
        if (this.dataSource.source === 'hyperdrive') {
            return 'postgresql'
        }
        if (this.dataSource.source === 'external') {
            return this.dataSource.external?.dialect ?? 'sqlite'
        }
        return 'sqlite'
    }

    private buildPrimaryKeyQuery(ref: TableRef): string {
        const dialect = this.resolveDialect()
        if (dialect === 'postgresql') {
            return buildPostgresPrimaryKeyQuery(ref)
        }
        if (dialect === 'mysql') {
            return buildMysqlPrimaryKeyQuery(ref)
        }
        return `PRAGMA table_info(${ref.tableName});`
    }

    /**
     * Queries table metadata to resolve primary key column names.
     */
    private async getPrimaryKeyColumns(ref: TableRef): Promise<string[]> {
        const query = this.buildPrimaryKeyQuery(ref)
        const schemaInfo = (await executeQuery({
            sql: query,
            params: [],
            isRaw: false,
            dataSource: this.dataSource,
            config: this.config,
            bypassAllowlist: true,
        })) as any[]

        if (this.resolveDialect() === 'sqlite') {
            return extractSqlitePkNames(schemaInfo)
        }

        return schemaInfo.map((col) => col.name as string)
    }

    private isDataValid(data: Record<string, unknown> | null): boolean {
        if (!data || typeof data !== 'object') {
            return false
        }
        return !Array.isArray(data)
    }

    private sanitizeOperator(operator: string | undefined): string {
        return ALLOWED_OPERATORS[operator || 'eq'] || '='
    }

    private resolvePrimaryKeyValue(opts: {
        pk: string
        id?: string
        data: any
        searchParams: URLSearchParams
        allowIdFallback: boolean
    }): any {
        const { pk, id, data, searchParams, allowIdFallback } = opts
        if (allowIdFallback && id) {
            return id
        }
        return data?.[pk] || searchParams.get(pk)
    }

    private getPrimaryKeyConditions(opts: {
        pkColumns: string[]
        id?: string
        data: any
        searchParams: URLSearchParams
    }): { conditions: string[]; params: any[]; error?: string } {
        const { pkColumns, id, data, searchParams } = opts
        const conditions: string[] = []
        const params: any[] = []
        const allowIdFallback = pkColumns?.length === 1

        for (const pk of pkColumns ?? []) {
            const pkValue = this.resolvePrimaryKeyValue({
                pk,
                id,
                data,
                searchParams,
                allowIdFallback,
            })
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

        return { conditions, params }
    }

    private async executeOperation(
        queries: { sql: string; params: any[] }[]
    ): Promise<{ result?: any; error?: string | undefined; status: number }> {
        const results: any[] = (await executeTransaction({
            queries,
            isRaw: false,
            dataSource: this.dataSource,
            config: this.config,
            bypassAllowlist: this.shouldBypassAllowlist(),
        })) as any[]
        return {
            result: results?.length > 0 ? results[0] : undefined,
            status: 200,
        }
    }

    private dispatchMethod(parsed: ParsedRestRequest): Promise<Response> {
        const handlers: Record<string, () => Promise<Response>> = {
            GET: () => this.handleGet(parsed),
            POST: () => this.handlePost(parsed),
            PATCH: () => this.handlePatch(parsed),
            PUT: () => this.handlePut(parsed),
            DELETE: () => this.handleDelete(parsed),
        }

        const handler = handlers[parsed.method]
        if (!handler) {
            return Promise.resolve(
                createResponse(undefined, 'Method not allowed', 405)
            )
        }
        return handler()
    }

    async handleRequest(request: Request): Promise<Response> {
        const parsed = await this.parseRequest(request)

        try {
            return await this.dispatchMethod(parsed)
        } catch (error: any) {
            console.error('LiteREST Error:', error)
            return createResponse(
                undefined,
                error.message || 'An unexpected error occurred',
                500
            )
        }
    }

    private async parseRequest(request: Request): Promise<ParsedRestRequest> {
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

    private appendSearchFilterCondition(opts: {
        key: string
        value: string
        conditions: string[]
        params: any[]
    }): void {
        const { key, value, conditions, params } = opts
        const [column, op] = key.split('.')
        const sanitizedColumn = this.sanitizeIdentifier(column)
        const operator = this.sanitizeOperator(op)

        if (operator === 'IN') {
            const values = value.split(',').map((val) => val.trim())
            const placeholders = values.map(() => '?').join(', ')
            conditions.push(`${sanitizedColumn} IN (${placeholders})`)
            params.push(...values)
            return
        }

        conditions.push(`${sanitizedColumn} ${operator} ?`)
        params.push(value)
    }

    private buildPaginationClause(opts: {
        limitParam: string | null
        offsetParam: string | null
        params: any[]
    }): string {
        const { limitParam, offsetParam, params } = opts
        const limit = limitParam ? parseInt(limitParam, 10) : 0
        if (!(limit > 0)) {
            return ''
        }

        params.push(limit)
        const offset = offsetParam ? parseInt(offsetParam, 10) : 0
        if (offset > 0) {
            params.push(offset)
            return ' LIMIT ? OFFSET ?'
        }

        return ' LIMIT ?'
    }

    private buildOrderByClause(opts: {
        sortBy: string | null
        orderParam: string | null
    }): string {
        const { sortBy, orderParam } = opts
        if (!sortBy) {
            return ''
        }
        const sanitizedSortBy = this.sanitizeIdentifier(sortBy)
        const order = orderParam?.toUpperCase() === 'DESC' ? 'DESC' : 'ASC'
        return ` ORDER BY ${sanitizedSortBy} ${order}`
    }

    private async buildSelectQuery(
        tableName: string,
        schemaName: string | undefined,
        id: string | undefined,
        searchParams: URLSearchParams
    ): Promise<{ query: string; params: any[] }> {
        const ref: TableRef = { tableName, schemaName, id }
        let query = `SELECT * FROM ${qualifyTable(ref)}`
        const params: any[] = []
        const conditions: string[] = []
        const pkColumns = await this.getPrimaryKeyColumns(ref)
        const pkFilter = this.getPrimaryKeyConditions({
            pkColumns,
            id,
            data: {},
            searchParams,
        })

        if (!pkFilter.error) {
            conditions.push(...pkFilter.conditions)
            params.push(...pkFilter.params)
        }

        const sortBy = searchParams.get('sort_by')
        const orderParam = searchParams.get('order')
        const limitParam = searchParams.get('limit')
        const offsetParam = searchParams.get('offset')

        RESERVED_SEARCH_PARAMS.forEach((param) => searchParams.delete(param))

        for (const [key, value] of searchParams.entries()) {
            if (!pkColumns.includes(key)) {
                this.appendSearchFilterCondition({
                    key,
                    value,
                    conditions,
                    params,
                })
            }
        }

        if (conditions.length > 0) {
            query += ` WHERE ${conditions.join(' AND ')}`
        }

        query += this.buildOrderByClause({ sortBy, orderParam })
        query += this.buildPaginationClause({
            limitParam,
            offsetParam,
            params,
        })

        return { query, params }
    }

    private async handleGet(req: ParsedRestRequest): Promise<Response> {
        const { query, params } = await this.buildSelectQuery(
            req.tableName,
            req.schemaName,
            req.id,
            req.searchParams
        )

        try {
            const response = await this.executeOperation([
                { sql: query, params },
            ])
            const resultData = Array.isArray(response.result)
                ? response.result
                : [response.result]
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

    private validatePayloadKeys(data: Record<string, unknown> | null): {
        keys?: string[]
        errorResponse?: Response
    } {
        if (!this.isDataValid(data)) {
            return {
                errorResponse: createResponse(
                    undefined,
                    'Invalid data format',
                    400
                ),
            }
        }

        const keys = Object.keys(data!)
        if (keys.length === 0) {
            return {
                errorResponse: createResponse(
                    undefined,
                    'No data provided',
                    400
                ),
            }
        }

        return { keys }
    }

    private async handlePost(req: ParsedRestRequest): Promise<Response> {
        const data = req.body
        const { keys: dataKeys, errorResponse } = this.validatePayloadKeys(data)
        if (errorResponse || !dataKeys) {
            return errorResponse!
        }

        const columns = dataKeys.map((col) => this.sanitizeIdentifier(col))
        const placeholders = columns.map(() => '?').join(', ')
        const qualified = qualifyTable(req)
        const query = `INSERT INTO ${qualified} (${columns.join(', ')}) VALUES (${placeholders})`
        const params = dataKeys.map((key) => data[key])

        try {
            await this.executeOperation([{ sql: query, params }])
            return createResponse(
                { message: 'Resource created successfully', data },
                undefined,
                201
            )
        } catch (error: any) {
            console.error('POST Operation Error:', error)
            const errorMessage =
                error.message || error.error || 'Failed to create resource'
            return createResponse(undefined, errorMessage, 500)
        }
    }

    private async executeUpdateMutation(opts: {
        req: ParsedRestRequest
        excludePrimaryKeys: boolean
        successMessage: string
        failureMessage: string
    }): Promise<Response> {
        const { req, excludePrimaryKeys, successMessage, failureMessage } = opts
        const data = req.body

        const pkColumns = await this.getPrimaryKeyColumns(req)
        const pkFilter = this.getPrimaryKeyConditions({
            pkColumns,
            id: req.id,
            data,
            searchParams: new URLSearchParams(),
        })
        if (pkFilter.error) {
            return createResponse(undefined, pkFilter.error, 400)
        }

        const { keys: dataKeys, errorResponse } = this.validatePayloadKeys(data)
        if (errorResponse || !dataKeys) {
            return errorResponse!
        }

        const targetKeys = excludePrimaryKeys
            ? dataKeys.filter((key) => !pkColumns.includes(key))
            : dataKeys
        if (targetKeys.length === 0) {
            return createResponse(undefined, 'No updatable data provided', 400)
        }

        const columns = targetKeys.map((col) => this.sanitizeIdentifier(col))
        const setClause = columns.map((col) => `${col} = ?`).join(', ')
        const qualified = qualifyTable(req)
        const query = `UPDATE ${qualified} SET ${setClause} WHERE ${pkFilter.conditions.join(' AND ')}`
        const params = [
            ...targetKeys.map((key) => data[key]),
            ...pkFilter.params,
        ]

        try {
            await this.executeOperation([{ sql: query, params }])
            return createResponse(
                { message: successMessage, data },
                undefined,
                200
            )
        } catch (error: any) {
            return createResponse(
                undefined,
                error.message || failureMessage,
                500
            )
        }
    }

    private async handlePatch(req: ParsedRestRequest): Promise<Response> {
        return this.executeUpdateMutation({
            req,
            excludePrimaryKeys: true,
            successMessage: 'Resource updated successfully',
            failureMessage: 'Failed to update resource',
        })
    }

    private async handlePut(req: ParsedRestRequest): Promise<Response> {
        return this.executeUpdateMutation({
            req,
            excludePrimaryKeys: false,
            successMessage: 'Resource replaced successfully',
            failureMessage: 'Failed to replace resource',
        })
    }

    private async handleDelete(req: ParsedRestRequest): Promise<Response> {
        const pkColumns = await this.getPrimaryKeyColumns(req)

        if (!req.id) {
            return createResponse(
                undefined,
                "Missing primary key value for 'id'",
                400
            )
        }

        if (!pkColumns.length) {
            return createResponse(
                undefined,
                `No primary key found for table '${req.tableName}'`,
                400
            )
        }

        const data: Record<string, string> = { [pkColumns[0]]: req.id }
        const pkFilter = this.getPrimaryKeyConditions({
            pkColumns,
            id: req.id,
            data,
            searchParams: new URLSearchParams(),
        })
        if (pkFilter.error) {
            return createResponse(undefined, pkFilter.error, 400)
        }

        const qualified = qualifyTable(req)
        const query = `DELETE FROM ${qualified} WHERE ${pkFilter.conditions.join(' AND ')}`

        try {
            await this.executeOperation([
                { sql: query, params: pkFilter.params },
            ])
            return createResponse(
                { message: 'Resource deleted successfully' },
                undefined,
                200
            )
        } catch (error: any) {
            return createResponse(
                undefined,
                error.message || 'Failed to delete resource',
                500
            )
        }
    }
}
