import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
    const connection = {
        connect: vi.fn(),
        raw: vi.fn(),
    }

    return {
        connection,
        pgClient: vi.fn(function MockPgClient(config: unknown) {
            return { driver: 'postgresql', config }
        }),
        mysqlClient: vi.fn((config: unknown) => ({
            driver: 'mysql',
            config,
        })),
        tursoClient: vi.fn((config: unknown) => ({
            driver: 'turso',
            config,
        })),
        PostgreSQLConnection: vi.fn(() => connection),
        MySQLConnection: vi.fn(() => connection),
        CloudflareD1Connection: vi.fn(() => connection),
        StarbaseConnection: vi.fn(() => connection),
        TursoConnection: vi.fn(() => connection),
    }
})

vi.mock('pg', () => ({ Client: mocks.pgClient }))
vi.mock('mysql2', () => ({ createConnection: mocks.mysqlClient }))
vi.mock('@libsql/client/web', () => ({ createClient: mocks.tursoClient }))
vi.mock('@outerbase/sdk', () => ({
    PostgreSQLConnection: mocks.PostgreSQLConnection,
    MySQLConnection: mocks.MySQLConnection,
    CloudflareD1Connection: mocks.CloudflareD1Connection,
    StarbaseConnection: mocks.StarbaseConnection,
    TursoConnection: mocks.TursoConnection,
}))

import { executeSDKQuery } from '../src/operation'

const config = {
    features: { allowlist: false, rls: false, rest: false },
}

function dataSource(external?: Record<string, unknown>) {
    return {
        source: 'external',
        external,
    } as any
}

beforeEach(() => {
    vi.clearAllMocks()
    mocks.connection.connect.mockResolvedValue(undefined)
    mocks.connection.raw.mockResolvedValue({ data: [{ id: 1 }] })
})

describe('executeSDKQuery adapter selection', () => {
    it('creates and queries a PostgreSQL connection', async () => {
        const external = {
            dialect: 'postgresql',
            host: 'postgres.example.com',
            port: 5432,
            user: 'reader',
            password: 'secret',
            database: 'app',
        }

        const result = await executeSDKQuery({
            sql: 'SELECT * FROM users WHERE id = $1',
            params: [1],
            dataSource: dataSource(external),
            config: config as any,
        })

        expect(mocks.pgClient).toHaveBeenCalledWith({
            host: external.host,
            port: external.port,
            user: external.user,
            password: external.password,
            database: external.database,
        })
        expect(mocks.PostgreSQLConnection).toHaveBeenCalledWith({
            driver: 'postgresql',
            config: expect.any(Object),
        })
        expect(mocks.connection.connect).toHaveBeenCalledOnce()
        expect(mocks.connection.raw).toHaveBeenCalledWith(
            'SELECT * FROM users WHERE id = $1',
            [1]
        )
        expect(result).toEqual([{ id: 1 }])
    })

    it('creates and queries a MySQL connection', async () => {
        const external = {
            dialect: 'mysql',
            host: 'mysql.example.com',
            port: 3306,
            user: 'reader',
            password: 'secret',
            database: 'app',
        }

        await executeSDKQuery({
            sql: 'SELECT ?',
            params: [42],
            dataSource: dataSource(external),
            config: config as any,
        })

        expect(mocks.mysqlClient).toHaveBeenCalledWith({
            host: external.host,
            port: external.port,
            user: external.user,
            password: external.password,
            database: external.database,
        })
        expect(mocks.MySQLConnection).toHaveBeenCalledWith({
            driver: 'mysql',
            config: expect.any(Object),
        })
        expect(mocks.connection.raw).toHaveBeenCalledWith('SELECT ?', [42])
    })

    it('creates and queries a Cloudflare D1 connection', async () => {
        const external = {
            dialect: 'sqlite',
            provider: 'cloudflare-d1',
            apiKey: 'api-key',
            accountId: 'account-id',
            databaseId: 'database-id',
        }

        await executeSDKQuery({
            sql: 'SELECT 1',
            params: undefined,
            dataSource: dataSource(external),
            config: config as any,
        })

        expect(mocks.CloudflareD1Connection).toHaveBeenCalledWith({
            apiKey: external.apiKey,
            accountId: external.accountId,
            databaseId: external.databaseId,
        })
        expect(mocks.connection.raw).toHaveBeenCalledWith('SELECT 1', undefined)
    })

    it('creates and queries a Starbase connection', async () => {
        const external = {
            dialect: 'sqlite',
            provider: 'starbase',
            apiKey: 'api-key',
            token: 'https://starbase.example.com',
        }

        await executeSDKQuery({
            sql: 'SELECT 1',
            params: [],
            dataSource: dataSource(external),
            config: config as any,
        })

        expect(mocks.StarbaseConnection).toHaveBeenCalledWith({
            apiKey: external.apiKey,
            url: external.token,
        })
        expect(mocks.connection.raw).toHaveBeenCalledWith('SELECT 1', [])
    })

    it('creates and queries a Turso connection', async () => {
        const external = {
            dialect: 'sqlite',
            provider: 'turso',
            uri: 'libsql://database.example.com',
            token: 'auth-token',
        }

        await executeSDKQuery({
            sql: 'SELECT 1',
            params: [],
            dataSource: dataSource(external),
            config: config as any,
        })

        expect(mocks.tursoClient).toHaveBeenCalledWith({
            url: external.uri,
            authToken: external.token,
        })
        expect(mocks.TursoConnection).toHaveBeenCalledWith({
            driver: 'turso',
            config: expect.any(Object),
        })
        expect(mocks.connection.raw).toHaveBeenCalledWith('SELECT 1', [])
    })

    it('returns an empty result when no external source is configured', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

        const result = await executeSDKQuery({
            sql: 'SELECT 1',
            params: [],
            dataSource: dataSource(),
            config: config as any,
        })

        expect(result).toEqual([])
        expect(warn).toHaveBeenCalledWith('No external connection found')
        expect(mocks.connection.connect).not.toHaveBeenCalled()
    })

    it('rejects unsupported external database types before connecting', async () => {
        await expect(
            executeSDKQuery({
                sql: 'SELECT 1',
                params: [],
                dataSource: dataSource({
                    dialect: 'sqlite',
                    provider: 'unknown',
                }),
                config: config as any,
            })
        ).rejects.toThrow('Unsupported external database type')

        expect(mocks.connection.connect).not.toHaveBeenCalled()
    })
})
