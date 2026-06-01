import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StarbaseDBConfiguration } from './handler'
import type { DataSource, ExternalDatabaseSource } from './types'

const sdkMocks = vi.hoisted(() => {
    type MockConnection = {
        kind: string
        config: unknown
        connect: ReturnType<typeof vi.fn>
        raw: ReturnType<typeof vi.fn>
    }

    const connections: MockConnection[] = []

    const makeConnectionClass = (kind: string) =>
        vi.fn((config: unknown) => {
            const connection = {
                kind,
                config,
                connect: vi.fn().mockResolvedValue(undefined),
                raw: vi.fn().mockResolvedValue({ data: [{ source: kind }] }),
            }
            connections.push(connection)
            return connection
        })

    return {
        connections,
        PostgreSQLConnection: makeConnectionClass('postgresql'),
        MySQLConnection: makeConnectionClass('mysql'),
        CloudflareD1Connection: makeConnectionClass('cloudflare-d1'),
        StarbaseConnection: makeConnectionClass('starbase'),
        TursoConnection: makeConnectionClass('turso'),
    }
})

const driverMocks = vi.hoisted(() => ({
    PgClient: vi.fn((config: unknown) => ({ driver: 'pg', config })),
    createMySqlConnection: vi.fn((config: unknown) => ({
        driver: 'mysql2',
        config,
    })),
    createTursoConnection: vi.fn((config: unknown) => ({
        driver: 'libsql',
        config,
    })),
}))

vi.mock('@outerbase/sdk', () => ({
    PostgreSQLConnection: sdkMocks.PostgreSQLConnection,
    MySQLConnection: sdkMocks.MySQLConnection,
    CloudflareD1Connection: sdkMocks.CloudflareD1Connection,
    StarbaseConnection: sdkMocks.StarbaseConnection,
    TursoConnection: sdkMocks.TursoConnection,
}))

vi.mock('pg', () => ({ Client: driverMocks.PgClient }))

vi.mock('mysql2', () => ({
    createConnection: driverMocks.createMySqlConnection,
}))

vi.mock('@libsql/client/web', () => ({
    createClient: driverMocks.createTursoConnection,
}))

import { executeExternalQuery, executeSDKQuery } from './operation'

const config = {
    role: 'admin',
    features: { allowlist: false, rls: false, rest: true },
} as StarbaseDBConfiguration

function createDataSource(external?: ExternalDatabaseSource): DataSource {
    return {
        source: 'external',
        external,
        rpc: {} as DataSource['rpc'],
    }
}

describe('executeSDKQuery external source routing', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        sdkMocks.connections.length = 0
    })

    it('uses PostgreSQL connection settings and returns raw data', async () => {
        const external = {
            dialect: 'postgresql',
            host: 'db.example.com',
            port: 5432,
            user: 'reporter',
            password: 'secret',
            database: 'analytics',
            defaultSchema: 'custom',
        } satisfies ExternalDatabaseSource

        const result = await executeSDKQuery({
            sql: 'SELECT * FROM reports',
            params: ['active'],
            dataSource: createDataSource(external),
            config,
        })

        expect(driverMocks.PgClient).toHaveBeenCalledWith({
            host: 'db.example.com',
            port: 5432,
            user: 'reporter',
            password: 'secret',
            database: 'analytics',
        })
        expect(sdkMocks.PostgreSQLConnection).toHaveBeenCalledWith({
            driver: 'pg',
            config: expect.objectContaining({ database: 'analytics' }),
        })
        expect(sdkMocks.connections[0].connect).toHaveBeenCalledTimes(1)
        expect(sdkMocks.connections[0].raw).toHaveBeenCalledWith(
            'SELECT * FROM reports',
            ['active']
        )
        expect(result).toEqual([{ source: 'postgresql' }])
    })

    it('uses MySQL connection settings', async () => {
        const external = {
            dialect: 'mysql',
            host: 'mysql.example.com',
            port: 3306,
            user: 'writer',
            password: 'secret',
            database: 'app',
        } satisfies ExternalDatabaseSource

        await executeSDKQuery({
            sql: 'SELECT id FROM users',
            params: [],
            dataSource: createDataSource(external),
            config,
        })

        expect(driverMocks.createMySqlConnection).toHaveBeenCalledWith({
            host: 'mysql.example.com',
            port: 3306,
            user: 'writer',
            password: 'secret',
            database: 'app',
        })
        expect(sdkMocks.MySQLConnection).toHaveBeenCalledWith({
            driver: 'mysql2',
            config: expect.objectContaining({ database: 'app' }),
        })
        expect(sdkMocks.connections[0].raw).toHaveBeenCalledWith(
            'SELECT id FROM users',
            []
        )
    })

    it.each([
        [
            'cloudflare-d1',
            {
                dialect: 'sqlite',
                provider: 'cloudflare-d1',
                apiKey: 'cf-key',
                accountId: 'account-id',
                databaseId: 'database-id',
            },
            sdkMocks.CloudflareD1Connection,
            {
                apiKey: 'cf-key',
                accountId: 'account-id',
                databaseId: 'database-id',
            },
        ],
        [
            'starbase',
            {
                dialect: 'sqlite',
                provider: 'starbase',
                apiKey: 'starbase-key',
                token: 'starbase-token',
            },
            sdkMocks.StarbaseConnection,
            {
                apiKey: 'starbase-key',
                url: 'starbase-token',
            },
        ],
        [
            'turso',
            {
                dialect: 'sqlite',
                provider: 'turso',
                uri: 'libsql://example.turso.io',
                token: 'turso-token',
            },
            sdkMocks.TursoConnection,
            {
                driver: 'libsql',
                config: {
                    url: 'libsql://example.turso.io',
                    authToken: 'turso-token',
                },
            },
        ],
    ])(
        'uses the %s SDK connection path',
        async (_kind, external, expectedConstructor, expectedConfig) => {
            const result = await executeSDKQuery({
                sql: 'SELECT 1',
                params: undefined,
                dataSource: createDataSource(
                    external as ExternalDatabaseSource
                ),
                config,
            })

            if (_kind === 'turso') {
                const expectedTursoConfig = (
                    expectedConfig as {
                        config: { url: string; authToken: string }
                    }
                ).config
                expect(driverMocks.createTursoConnection).toHaveBeenCalledWith(
                    expectedTursoConfig
                )
            }
            expect(expectedConstructor).toHaveBeenCalledWith(expectedConfig)
            expect(sdkMocks.connections[0].connect).toHaveBeenCalledTimes(1)
            expect(sdkMocks.connections[0].raw).toHaveBeenCalledWith(
                'SELECT 1',
                undefined
            )
            expect(result).toEqual([{ source: _kind }])
        }
    )

    it('returns an empty result when no external source is configured', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

        const result = await executeSDKQuery({
            sql: 'SELECT 1',
            params: [],
            dataSource: createDataSource(),
            config,
        })

        expect(result).toEqual([])
        expect(warnSpy).toHaveBeenCalledWith('No external connection found')
        expect(sdkMocks.connections).toHaveLength(0)
    })

    it('rejects unsupported external database providers', async () => {
        await expect(
            executeSDKQuery({
                sql: 'SELECT 1',
                params: [],
                dataSource: createDataSource({
                    dialect: 'sqlite',
                    provider: 'unsupported',
                } as unknown as ExternalDatabaseSource),
                config,
            })
        ).rejects.toThrow('Unsupported external database type')
    })
})

describe('executeExternalQuery SDK fallback and API payloads', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        sdkMocks.connections.length = 0
    })

    it('falls back to the SDK path when no Outerbase API key is configured', async () => {
        const external = {
            dialect: 'mysql',
            host: 'mysql.example.com',
            port: 3306,
            user: 'reader',
            password: 'secret',
            database: 'warehouse',
        } satisfies ExternalDatabaseSource
        const fetchSpy = vi.spyOn(globalThis, 'fetch')

        const result = await executeExternalQuery({
            sql: 'SELECT * FROM orders WHERE status = ?',
            params: ['paid'],
            dataSource: createDataSource(external),
            config,
        })

        expect(fetchSpy).not.toHaveBeenCalled()
        expect(sdkMocks.MySQLConnection).toHaveBeenCalledTimes(1)
        expect(sdkMocks.connections[0].raw).toHaveBeenCalledWith(
            'SELECT * FROM orders WHERE status = ?',
            ['paid']
        )
        expect(result).toEqual([{ source: 'mysql' }])
    })

    it('preserves object params and normalizes query newlines for Outerbase API requests', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
            json: async () => ({
                response: {
                    results: {
                        items: [{ id: 7, status: 'active' }],
                    },
                },
            }),
        } as Response)
        const external = {
            dialect: 'postgresql',
            host: 'db.example.com',
            port: 5432,
            user: 'reporter',
            password: 'secret',
            database: 'analytics',
        } satisfies ExternalDatabaseSource

        const result = await executeExternalQuery({
            sql: 'SELECT *\nFROM users\nWHERE id > :minId',
            params: { minId: 5 },
            dataSource: createDataSource(external),
            config: {
                ...config,
                outerbaseApiKey: 'outerbase-api-key',
            },
        })

        expect(fetchSpy).toHaveBeenCalledWith(
            'https://app.outerbase.com/api/v1/ezql/raw',
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Source-Token': 'outerbase-api-key',
                },
                body: JSON.stringify({
                    query: 'SELECT * FROM users WHERE id > :minId',
                    params: { minId: 5 },
                }),
            }
        )
        expect(result).toEqual([{ id: 7, status: 'active' }])
    })
})
