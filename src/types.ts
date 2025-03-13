/// <reference types="@cloudflare/workers-types" />
import type {
    DurableObject,
    DurableObjectState,
    DurableObjectNamespace,
    R2Bucket,
    ExecutionContext,
} from '@cloudflare/workers-types'

import { StarbasePlugin, StarbasePluginRegistry } from './plugin'

// Define the DurableObjectStub type
type DurableObjectStub<T> = {
    init: () => Promise<T>
}

// Define the unique symbol
declare const __DURABLE_OBJECT_BRAND: unique symbol

export interface DurableObjectBranded {
    [__DURABLE_OBJECT_BRAND]: typeof __DURABLE_OBJECT_BRAND
}

export type QueryResult = Record<string, SqlStorageValue>

export type RemoteSource = {
    host: string
    port: number
    user: string
    password: string
    database: string
    defaultSchema?: string
}

export type PostgresSource = {
    dialect: 'postgresql'
    host: string
    port: number
    user: string
    password: string
    database: string
}

export type MySQLSource = {
    dialect: 'mysql'
    host: string
    port: number
    user: string
    password: string
    database: string
}

export type CloudflareD1Source = {
    dialect: 'sqlite'
    provider: 'cloudflare-d1'
    apiKey: string
    accountId: string
    databaseId: string
} & Pick<RemoteSource, 'defaultSchema'>

export type StarbaseDBSource = {
    dialect: 'sqlite'
    provider: 'starbase'
    apiKey: string
    token: string
} & Pick<RemoteSource, 'defaultSchema'>

export type TursoDBSource = {
    dialect: 'sqlite'
    provider: 'turso'
    uri: string
    token: string
} & Pick<RemoteSource, 'defaultSchema'>

export type ExternalDatabaseSource =
    | PostgresSource
    | MySQLSource
    | CloudflareD1Source
    | StarbaseDBSource
    | TursoDBSource

export type StarbaseDBDurableObject = {
    executeQuery: (opts: {
        sql: string
        params?: unknown[]
        isRaw?: boolean
    }) => Promise<any[]>
    init: () => Promise<{
        executeQuery: (opts: {
            sql: string
            params?: unknown[]
        }) => Promise<any>
        getAlarm: () => Promise<number | null>
        setAlarm: (time: number, options?: any) => Promise<void>
        deleteAlarm: (options?: any) => Promise<void>
        getStatistics: () => Promise<any>
    }>
}

export type DataSource = {
    rpc:
        | Response
        | Awaited<
              ReturnType<DurableObjectStub<StarbaseDBDurableObject>['init']>
          >
    source: 'internal' | 'external' | 'hyperdrive'
    external?: ExternalDatabaseSource
    context?: Record<string, unknown>
    cache?: boolean
    cacheTTL?: number
    registry?: StarbasePluginRegistry
    executionContext?: ExecutionContext
    storage?: {
        get: (key: string) => Promise<any>
        put: (key: string, value: any) => Promise<void>
        setAlarm: (time: number, options?: any) => Promise<void>
    }
}

export enum RegionLocationHint {
    AUTO = 'auto',
    WNAM = 'wnam',
    ENAM = 'enam',
    SAM = 'sam',
    WEUR = 'weur',
    EEUR = 'eeur',
    APAC = 'apac',
    OC = 'oc',
    AFR = 'afr',
    ME = 'me',
}

export interface DumpOptions {
    format: 'sql' | 'csv' | 'json'
    callbackUrl?: string
    chunkSize?: number
    dumpId: string
}

export interface TableInfo {
    name: string
    sql: string
}

export interface DumpState {
    id: string
    status: 'pending' | 'processing' | 'completed' | 'failed'
    currentOffset: number
    totalRows: number
    format: 'sql' | 'csv' | 'json'
    error?: string
    callbackUrl?: string
    currentTable: string
    tables: string[]
    processedTables: string[]
}

export interface Env {
    ADMIN_AUTHORIZATION_TOKEN: string
    CLIENT_AUTHORIZATION_TOKEN: string
    DATABASE_DURABLE_OBJECT: DurableObjectNamespace
    REGION: string
    BUCKET: R2Bucket
}

export interface StarbaseDBConfiguration {
    role: 'admin' | 'client'
    outerbaseApiKey: string
    features: {
        rls: boolean
        allowlist: boolean
        rest: boolean
        export: boolean
        import: boolean
    }
    BUCKET: any
    dialect?: string
    export?: {
        maxRetries?: number
        breathingTimeMs?: number
        chunkSize?: number
        timeoutMs?: number
    }
}
