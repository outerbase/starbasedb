import { StarbaseDBDurableObject } from './do'
import { StarbasePlugin, StarbasePluginRegistry } from './plugin'

type Stub<T> = T & { dispose?: () => void }

export type StubArrayBuffer = {
    readonly byteLength: number
    slice: (begin: number, end?: number) => Promise<ArrayBuffer>
    readonly [Symbol.toStringTag]: string
} & { dispose?: () => void }

export type SqlStorageValue =
    | string
    | number
    | boolean
    | null
    | ArrayBuffer
    | StubArrayBuffer

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
} & RemoteSource

export type MySQLSource = {
    dialect: 'mysql'
} & RemoteSource

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

export type DataSource = {
    rpc: {
        executeQuery: (opts: {
            sql: string
            params?: unknown[]
            isRaw?: boolean
        }) => Promise<
            | Record<string, SqlStorageValue>[]
            | {
                  columns: string[]
                  rows: SqlStorageValue[][]
                  meta: {
                      rows_read: number
                      rows_written: number
                  }
              }
        > & { dispose?: () => void }
        storage:
            | DurableObjectStorage
            | {
                  get: DurableObjectStorage['get']
                  put: DurableObjectStorage['put']
                  delete: DurableObjectStorage['delete']
                  list: DurableObjectStorage['list']
              }
        setAlarm: ((timestamp: number) => Promise<void>) & {
            dispose?: () => void
        }
    }
    source: 'internal' | 'external'
    external?: ExternalDatabaseSource
    context?: Record<string, unknown>
    cache?: boolean
    cacheTTL?: number
    registry?: StarbasePluginRegistry
}

export enum RegionLocationHint {
    AUTO = 'auto',
    WNAM = 'wnam', // Western North America
    ENAM = 'enam', // Eastern North America
    SAM = 'sam', // South America
    WEUR = 'weur', // Western Europe
    EEUR = 'eeur', // Eastern Europe
    APAC = 'apac', // Asia Pacific
    OC = 'oc', // Oceania
    AFR = 'afr', // Africa
    ME = 'me', // Middle East
}
