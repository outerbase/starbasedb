import { Client as PgClient } from 'pg'
import { createConnection as createMySqlConnection } from 'mysql2'
import { createClient as createTursoConnection } from '@libsql/client/web'
import postgres from 'postgres'

import {
    CloudflareD1Connection,
    MySQLConnection,
    PostgreSQLConnection,
    StarbaseConnection,
    TursoConnection,
} from '@outerbase/sdk'
import {
    CloudflareD1Source,
    DataSource,
    RemoteSource,
    StarbaseDBSource,
    TursoDBSource,
} from './types'
import { StarbaseDBConfiguration } from './handler'
import { afterQueryCache, beforeQueryCache } from './cache'
import { isQueryAllowed } from './allowlist'
import { applyRLS } from './rls'
import type { SqlConnection } from '@outerbase/sdk/dist/connections/sql-base'

export type OperationQueueItem = {
    queries: { sql: string; params?: any[] }[]
    isTransaction: boolean
    isRaw: boolean
    resolve: (value: any) => void
    reject: (reason?: any) => void
}

export type RawQueryResponse = {
    columns: string[]
    rows: unknown[]
    meta: {
        rows_read: number
        rows_written: number
    }
}

export type QueryResponse = unknown[] | RawQueryResponse

export type ConnectionDetails = {
    database: SqlConnection
    defaultSchema: string
}

async function beforeQuery(opts: {
    sql: string
    params?: unknown[]
    dataSource?: DataSource
    config?: StarbaseDBConfiguration
}): Promise<{ sql: string; params?: unknown[] }> {
    const { sql, params, dataSource } = opts
    if (!dataSource?.registry) {
        return { sql, params }
    }
    return dataSource.registry.beforeQuery(opts)
}

async function afterQuery(opts: {
    sql: string
    result: any
    isRaw: boolean
    dataSource?: DataSource
    config?: StarbaseDBConfiguration
}): Promise<any> {
    const { isRaw, dataSource } = opts
    let result = isRaw ? transformRawResults(opts.result, 'from') : opts.result

    if (dataSource?.registry?.afterQuery) {
        try {
            result = await dataSource.registry.afterQuery({ ...opts, result })
        } catch (error) {
            console.error('Error in dataSource.registry.afterQuery:', error)
        }
    }

    return isRaw ? transformRawResults(result, 'to') : result
}

function mapRawRowToObject(columns: string[], row: any): Record<string, any> {
    return columns.reduce((obj: Record<string, any>, column: string, index) => {
        obj[column] = row[index]
        return obj
    }, {})
}

function transformRawResults(
    result: any,
    direction: 'to' | 'from'
): Record<string, any> {
    if (direction === 'from') {
        if (Array.isArray(result)) {
            return result
        }
        return result?.rows?.map((row: any) =>
            mapRawRowToObject(result.columns, row)
        )
    }

    const columns: string[] = Object.keys(result?.[0] || {})
    const rows =
        result?.map((row: any) => columns.map((col) => row[col])) ?? []

    return {
        columns,
        rows,
        meta: {
            rows_read: rows.length,
            rows_written: 0,
        },
    }
}

function formatOuterbaseQueryPayload(sql: string, params: any) {
    if (!Array.isArray(params)) {
        return {
            query: sql.replaceAll('\n', ' '),
            params,
        }
    }

    let paramIndex = 0
    const namedParams = params.reduce(
        (acc, value, index) => ({
            ...acc,
            [`param${index}`]: value,
        }),
        {}
    )
    const parameterizedSql = sql
        .replace(/\?/g, () => `:param${paramIndex++}`)
        .replaceAll('\n', ' ')

    return {
        query: parameterizedSql,
        params: namedParams,
    }
}

async function extractOuterbaseItems(response: Response): Promise<any[]> {
    const results: any = await response.json()
    const items = results?.response?.results?.items
    if (!items) {
        console.error('API response is malformed:', results)
        return []
    }
    return items
}

export async function executeExternalQuery(opts: {
    sql: string
    params: any
    dataSource: DataSource
    config: StarbaseDBConfiguration
}): Promise<any> {
    const { sql, params, dataSource, config } = opts

    if (!dataSource.external) {
        throw new Error('External connection not found.')
    }

    if (!config?.outerbaseApiKey) {
        return executeSDKQuery({ sql, params, dataSource, config })
    }

    const payload = formatOuterbaseQueryPayload(sql, params)
    const response = await fetch('https://app.outerbase.com/api/v1/ezql/raw', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Source-Token': config.outerbaseApiKey,
        },
        body: JSON.stringify(payload),
    })

    return extractOuterbaseItems(response)
}

function getHyperdriveConnectionString(dataSource: DataSource): string {
    const external = dataSource.external
    if (!external || !('connectionString' in external)) {
        throw new Error('Hyperdrive connection string not found')
    }
    return external.connectionString
}

async function executeHyperdriveQuery(opts: {
    sql: string
    params: unknown[] | undefined
    dataSource: DataSource
}): Promise<any> {
    const { sql: querySql, params, dataSource } = opts
    const connectionString = getHyperdriveConnectionString(dataSource)
    const sqlClient = postgres(connectionString, {
        max: 5,
        fetch_types: false,
    })

    try {
        const result = await sqlClient.unsafe(querySql, params as any[])
        if (dataSource.executionContext) {
            dataSource.executionContext.waitUntil(sqlClient.end())
        } else {
            await sqlClient.end()
        }
        return result
    } catch (error) {
        console.error('Hyperdrive query error:', error)
        throw error
    }
}

async function dispatchQueryExecution(opts: {
    sql: string
    params: unknown[] | undefined
    isRaw: boolean
    dataSource: DataSource
    config: StarbaseDBConfiguration
}): Promise<any> {
    const { sql, params, isRaw, dataSource, config } = opts

    if (dataSource.source === 'internal') {
        const result = await dataSource.rpc.executeQuery({
            sql,
            params,
            isRaw,
        })
        if (!result) {
            console.error('Returning empty array.')
            return []
        }
        return result
    }

    if (dataSource.source === 'hyperdrive') {
        return executeHyperdriveQuery({ sql, params, dataSource })
    }

    return executeExternalQuery({
        sql,
        params,
        dataSource,
        config,
    })
}

async function runQueryPipeline(opts: {
    rlsSql: string
    params: unknown[] | undefined
    isRaw: boolean
    dataSource: DataSource
    config: StarbaseDBConfiguration
}): Promise<QueryResponse> {
    const { rlsSql, params, isRaw, dataSource, config } = opts
    const { sql: updatedSQL, params: updatedParams } = await beforeQuery({
        sql: rlsSql,
        params,
        dataSource,
        config,
    })

    if (!isRaw) {
        const cached = await beforeQueryCache({
            sql: updatedSQL,
            params: updatedParams,
            dataSource,
        })
        if (cached) {
            return cached as QueryResponse
        }
    }

    const result = await dispatchQueryExecution({
        sql: updatedSQL,
        params: updatedParams,
        isRaw,
        dataSource,
        config,
    })

    if (!isRaw) {
        await afterQueryCache({
            sql: rlsSql,
            params: updatedParams,
            result,
            dataSource,
        })
    }

    return afterQuery({
        sql: updatedSQL,
        result,
        isRaw,
        dataSource,
        config,
    })
}

export async function executeQuery(opts: {
    sql: string
    params: unknown[] | undefined
    isRaw: boolean
    dataSource: DataSource
    config: StarbaseDBConfiguration
    bypassAllowlist?: boolean
}): Promise<QueryResponse> {
    const {
        sql: initialSql,
        params,
        isRaw,
        dataSource,
        config,
        bypassAllowlist,
    } = opts

    if (!dataSource) {
        console.error('Data source not found.')
        return []
    }

    const shouldEnforceAllowlist =
        Boolean(config?.features?.allowlist) && !bypassAllowlist

    await isQueryAllowed({
        sql: initialSql,
        isEnabled: shouldEnforceAllowlist,
        dataSource,
        config,
    })

    const rlsSql = await applyRLS({
        sql: initialSql,
        isEnabled: config?.features?.rls ?? true,
        dataSource,
        config,
    })

    return runQueryPipeline({
        rlsSql,
        params,
        isRaw,
        dataSource,
        config,
    })
}

export async function executeTransaction(opts: {
    queries: { sql: string; params?: any[] }[]
    isRaw: boolean
    dataSource: DataSource
    config: StarbaseDBConfiguration
    bypassAllowlist?: boolean
}): Promise<QueryResponse> {
    const { queries, isRaw, dataSource, config, bypassAllowlist } = opts

    if (!dataSource) {
        console.error('Data source not found.')
        return []
    }

    const results = []

    for (const query of queries) {
        const result = await executeQuery({
            sql: query.sql,
            params: query.params,
            isRaw,
            dataSource,
            config,
            bypassAllowlist,
        })

        results.push(result)
    }

    return results
}

function buildRemoteClientConfig(source: RemoteSource) {
    return {
        host: source.host,
        port: source.port,
        user: source.user,
        password: source.password,
        database: source.database,
    }
}

const SQLITE_PROVIDER_FACTORIES: Record<
    string,
    (source: any) => SqlConnection
> = {
    'cloudflare-d1': (source: CloudflareD1Source) =>
        new CloudflareD1Connection({
            apiKey: source.apiKey,
            accountId: source.accountId,
            databaseId: source.databaseId,
        }),
    starbase: (source: StarbaseDBSource) =>
        new StarbaseConnection({
            apiKey: source.apiKey,
            url: source.token,
        }),
    turso: (source: TursoDBSource) =>
        new TursoConnection(
            createTursoConnection({
                url: source.uri,
                authToken: source.token,
            })
        ),
}

function createSDKConnection(
    external: NonNullable<DataSource['external']>
): SqlConnection {
    if (external.dialect === 'postgresql' && 'host' in external) {
        return new PostgreSQLConnection(
            new PgClient(buildRemoteClientConfig(external))
        )
    }

    if (external.dialect === 'mysql') {
        return new MySQLConnection(
            createMySqlConnection(buildRemoteClientConfig(external))
        )
    }

    const provider = 'provider' in external ? external.provider : ''
    const factory = SQLITE_PROVIDER_FACTORIES[provider]
    if (!factory) {
        throw new Error('Unsupported external database type')
    }

    return factory(external)
}

export async function executeSDKQuery(opts: {
    sql: string
    params?: unknown[] | undefined
    dataSource: DataSource
    config: StarbaseDBConfiguration
}) {
    const external = opts.dataSource.external

    if (!external) {
        console.warn('No external connection found')
        return []
    }

    const connection = createSDKConnection(external)
    await connection.connect()

    const { data } = await connection.raw(opts.sql, opts.params)
    return data
}
