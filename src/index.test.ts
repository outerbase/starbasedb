import { beforeEach, describe, expect, it, vi } from 'vitest'
import { jwtVerify } from 'jose'
import { StarbaseDB } from './handler'
import worker from './index'
import type { Env } from './index'

const {
    mockHandle,
    mockHandlePreAuth,
    mockMatchesRoute,
    mockJwtVerify,
    mockCreateRemoteJWKSet,
} = vi.hoisted(() => ({
    mockHandle: vi.fn(),
    mockHandlePreAuth: vi.fn(),
    mockMatchesRoute: vi.fn(),
    mockJwtVerify: vi.fn(),
    mockCreateRemoteJWKSet: vi.fn(() => 'jwks'),
}))

vi.mock('cloudflare:workers', () => ({
    DurableObject: class DurableObject {},
}))

vi.mock('jose', () => ({
    jwtVerify: mockJwtVerify,
    createRemoteJWKSet: mockCreateRemoteJWKSet,
}))

vi.mock('./handler', () => ({
    StarbaseDB: vi.fn().mockImplementation(() => ({
        handle: mockHandle,
        handlePreAuth: mockHandlePreAuth,
    })),
}))

vi.mock('../plugins/websocket', () => ({
    WebSocketPlugin: class WebSocketPlugin {},
}))

vi.mock('../plugins/studio', () => ({
    StudioPlugin: class StudioPlugin {
        constructor(_opts: unknown) {}
    },
}))

vi.mock('../plugins/sql-macros', () => ({
    SqlMacrosPlugin: class SqlMacrosPlugin {
        constructor(_opts: unknown) {}
    },
}))

vi.mock('../plugins/cdc', () => ({
    ChangeDataCapturePlugin: class ChangeDataCapturePlugin {
        constructor(_opts: unknown) {}
        onEvent() {}
    },
}))

vi.mock('../plugins/query-log', () => ({
    QueryLogPlugin: class QueryLogPlugin {
        constructor(_opts: unknown) {}
    },
}))

vi.mock('../plugins/stats', () => ({
    StatsPlugin: class StatsPlugin {},
}))

vi.mock('../plugins/cron', () => ({
    CronPlugin: class CronPlugin {
        onEvent() {}
    },
}))

vi.mock('../plugins/interface', () => ({
    InterfacePlugin: class InterfacePlugin {
        matchesRoute = mockMatchesRoute
    },
}))

function createEnv(overrides: Partial<Env> = {}) {
    const rpc = { executeQuery: vi.fn() }
    const stub = { init: vi.fn().mockResolvedValue(rpc) }
    const id = { toString: () => 'sql-durable-object' }

    return {
        env: {
            ADMIN_AUTHORIZATION_TOKEN: 'admin-token',
            CLIENT_AUTHORIZATION_TOKEN: 'client-token',
            DATABASE_DURABLE_OBJECT: {
                idFromName: vi.fn().mockReturnValue(id),
                get: vi.fn().mockReturnValue(stub),
            },
            REGION: 'auto',
            ...overrides,
        } as unknown as Env,
        stub,
        id,
        rpc,
    }
}

const ctx = {
    waitUntil: vi.fn(),
} as unknown as ExecutionContext

async function readError(response: Response) {
    return (await response.json()) as { result?: unknown; error?: string }
}

beforeEach(() => {
    vi.clearAllMocks()
    mockHandle.mockResolvedValue(new Response('ok', { status: 200 }))
    mockHandlePreAuth.mockResolvedValue(undefined)
    mockMatchesRoute.mockReturnValue(false)
})

describe('worker fetch handler', () => {
    it('returns a CORS preflight response for OPTIONS', async () => {
        const { env } = createEnv()
        const response = await worker.fetch(
            new Request('https://db.example/query', { method: 'OPTIONS' }),
            env,
            ctx
        )

        expect(response.status).toBe(204)
        expect(mockHandle).not.toHaveBeenCalled()
    })

    it('returns 401 when no authentication token is provided', async () => {
        const { env } = createEnv()
        const response = await worker.fetch(
            new Request('https://db.example/query'),
            env,
            ctx
        )

        expect(response.status).toBe(401)
        expect((await readError(response)).error).toBe('Unauthorized request')
    })

    it('authorizes an admin bearer token and marks the role as admin', async () => {
        const { env } = createEnv()
        const response = await worker.fetch(
            new Request('https://db.example/query', {
                headers: { Authorization: 'Bearer admin-token' },
            }),
            env,
            ctx
        )

        expect(response.status).toBe(200)
        expect(StarbaseDB).toHaveBeenCalled()
        const constructed = vi.mocked(StarbaseDB).mock.calls[0][0]
        expect(constructed.config.role).toBe('admin')
        expect(mockHandle).toHaveBeenCalled()
    })

    it('authorizes a client bearer token without promoting the role', async () => {
        const { env } = createEnv()
        await worker.fetch(
            new Request('https://db.example/query', {
                headers: { Authorization: 'Bearer client-token' },
            }),
            env,
            ctx
        )

        const constructed = vi.mocked(StarbaseDB).mock.calls[0][0]
        expect(constructed.config.role).toBe('client')
    })

    it('reads the websocket token from the query string', async () => {
        const { env } = createEnv()
        const response = await worker.fetch(
            new Request('https://db.example/socket?token=admin-token', {
                headers: { Upgrade: 'websocket' },
            }),
            env,
            ctx
        )

        expect(response.status).toBe(200)
        expect(mockHandle).toHaveBeenCalled()
    })

    it('returns 401 when a websocket upgrade has no token', async () => {
        const { env } = createEnv()
        const response = await worker.fetch(
            new Request('https://db.example/socket', {
                headers: { Upgrade: 'websocket' },
            }),
            env,
            ctx
        )

        expect(response.status).toBe(401)
    })

    it('rejects unknown tokens when JWT is not configured', async () => {
        const { env } = createEnv()
        const response = await worker.fetch(
            new Request('https://db.example/query', {
                headers: { Authorization: 'Bearer not-a-real-token' },
            }),
            env,
            ctx
        )

        expect(response.status).toBe(400)
        expect((await readError(response)).error).toBe('Unauthorized request')
    })

    it('accepts a JWT and copies the payload onto the data source context', async () => {
        mockJwtVerify.mockResolvedValue({
            payload: { sub: 'user-42', role: 'member' },
        })
        const { env } = createEnv({
            AUTH_JWKS_ENDPOINT: 'https://auth.example/.well-known/jwks.json',
            AUTH_ALGORITHM: 'RS256',
        })

        const response = await worker.fetch(
            new Request('https://db.example/query', {
                headers: { Authorization: 'Bearer jwt-token' },
            }),
            env,
            ctx
        )

        expect(response.status).toBe(200)
        expect(mockCreateRemoteJWKSet).toHaveBeenCalled()
        expect(jwtVerify).toHaveBeenCalledWith(
            'jwt-token',
            'jwks',
            expect.objectContaining({ algorithms: ['RS256'] })
        )
        const constructed = vi.mocked(StarbaseDB).mock.calls[0][0]
        expect(constructed.dataSource.context).toMatchObject({
            sub: 'user-42',
            role: 'member',
        })
    })

    it('rejects a JWT without a subject', async () => {
        mockJwtVerify.mockResolvedValue({ payload: { role: 'member' } })
        const { env } = createEnv({
            AUTH_JWKS_ENDPOINT: 'https://auth.example/.well-known/jwks.json',
        })

        const response = await worker.fetch(
            new Request('https://db.example/query', {
                headers: { Authorization: 'Bearer jwt-token' },
            }),
            env,
            ctx
        )

        expect(response.status).toBe(400)
        expect((await readError(response)).error).toBe(
            'Invalid JWT payload, subject not found.'
        )
    })

    it('returns a pre-auth plugin response before authentication', async () => {
        mockHandlePreAuth.mockResolvedValue(
            new Response('studio', { status: 200 })
        )
        const { env } = createEnv()

        const response = await worker.fetch(
            new Request('https://db.example/studio'),
            env,
            ctx
        )

        expect(await response.text()).toBe('studio')
        expect(mockHandle).not.toHaveBeenCalled()
    })

    it('skips bearer auth when the interface plugin owns the route', async () => {
        mockMatchesRoute.mockReturnValue(true)
        const { env } = createEnv()

        const response = await worker.fetch(
            new Request('https://db.example/template'),
            env,
            ctx
        )

        expect(response.status).toBe(200)
        expect(mockHandle).toHaveBeenCalled()
    })

    it('selects an external source from the request header', async () => {
        const { env } = createEnv({
            EXTERNAL_DB_TYPE: 'postgresql',
            EXTERNAL_DB_HOST: 'db.internal',
            EXTERNAL_DB_PORT: 5432,
            EXTERNAL_DB_USER: 'app',
            EXTERNAL_DB_PASS: 'secret',
            EXTERNAL_DB_DATABASE: 'appdb',
            EXTERNAL_DB_DEFAULT_SCHEMA: 'public',
        })

        await worker.fetch(
            new Request('https://db.example/query', {
                headers: {
                    Authorization: 'Bearer admin-token',
                    'X-Starbase-Source': 'external',
                },
            }),
            env,
            ctx
        )

        const constructed = vi.mocked(StarbaseDB).mock.calls[0][0]
        expect(constructed.dataSource.source).toBe('external')
        expect(constructed.dataSource.external).toMatchObject({
            dialect: 'postgresql',
            host: 'db.internal',
            database: 'appdb',
        })
    })

    it('selects a mysql external source and hyperdrive when configured', async () => {
        const { env } = createEnv({
            EXTERNAL_DB_TYPE: 'mysql',
            EXTERNAL_DB_HOST: 'mysql.internal',
            EXTERNAL_DB_PORT: 3306,
            EXTERNAL_DB_USER: 'app',
            EXTERNAL_DB_PASS: 'secret',
            EXTERNAL_DB_DATABASE: 'appdb',
            HYPERDRIVE: {
                connectionString: 'postgres://hyperdrive',
            } as any,
        })

        await worker.fetch(
            new Request('https://db.example/query?source=hyperdrive', {
                headers: { Authorization: 'Bearer admin-token' },
            }),
            env,
            ctx
        )

        const constructed = vi.mocked(StarbaseDB).mock.calls[0][0]
        expect(constructed.dataSource.source).toBe('hyperdrive')
        expect(constructed.dataSource.external).toMatchObject({
            dialect: 'postgresql',
            connectionString: 'postgres://hyperdrive',
        })
    })

    it('configures sqlite providers from environment bindings', async () => {
        const { env } = createEnv({
            EXTERNAL_DB_TYPE: 'sqlite',
            EXTERNAL_DB_CLOUDFLARE_API_KEY: 'cf-key',
            EXTERNAL_DB_CLOUDFLARE_ACCOUNT_ID: 'acct',
            EXTERNAL_DB_CLOUDFLARE_DATABASE_ID: 'dbid',
            EXTERNAL_DB_STARBASEDB_URI: 'https://other.db',
            EXTERNAL_DB_STARBASEDB_TOKEN: 'sb-token',
            EXTERNAL_DB_TURSO_URI: 'libsql://db',
            EXTERNAL_DB_TURSO_TOKEN: 'turso-token',
        })

        await worker.fetch(
            new Request('https://db.example/query', {
                headers: {
                    Authorization: 'Bearer admin-token',
                    'X-Starbase-Source': 'INTERNAL',
                    'X-Starbase-Cache': 'true',
                },
            }),
            env,
            ctx
        )

        const constructed = vi.mocked(StarbaseDB).mock.calls[0][0]
        expect(constructed.dataSource.source).toBe('internal')
        expect(constructed.dataSource.cache).toBe(true)
        expect(constructed.dataSource.external).toMatchObject({
            dialect: 'sqlite',
            provider: 'turso',
            uri: 'libsql://db',
        })
    })

    it('passes a location hint when REGION is not auto', async () => {
        const { env, id, stub } = createEnv({ REGION: 'weur' })

        await worker.fetch(
            new Request('https://db.example/query', {
                headers: { Authorization: 'Bearer admin-token' },
            }),
            env,
            ctx
        )

        expect(env.DATABASE_DURABLE_OBJECT.get).toHaveBeenCalledWith(id, {
            locationHint: 'weur',
        })
        expect(stub.init).toHaveBeenCalled()
    })

    it('returns a 400 when initialization throws', async () => {
        const { env } = createEnv()
        vi.mocked(env.DATABASE_DURABLE_OBJECT.idFromName).mockImplementation(
            () => {
                throw new Error('binding missing')
            }
        )

        const response = await worker.fetch(
            new Request('https://db.example/query'),
            env,
            ctx
        )

        expect(response.status).toBe(400)
        expect((await readError(response)).error).toBe('binding missing')
    })

    it('returns a generic 400 when a non-Error is thrown', async () => {
        const { env } = createEnv()
        vi.mocked(env.DATABASE_DURABLE_OBJECT.idFromName).mockImplementation(
            () => {
                throw 'boom'
            }
        )

        const response = await worker.fetch(
            new Request('https://db.example/query'),
            env,
            ctx
        )

        expect(response.status).toBe(400)
        expect((await readError(response)).error).toBe(
            'An unexpected error occurred'
        )
    })
})
