import { describe, it, expect, vi, beforeEach } from 'vitest'
import worker, { Env } from './index'
import { StarbaseDB } from './handler'
import { corsPreflight } from './cors'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { WebSocketPlugin } from '../plugins/websocket'
import { InterfacePlugin } from '../plugins/interface'

vi.mock('./do', () => ({
    StarbaseDBDurableObject: vi.fn(),
}))

vi.mock('./utils', () => ({
    createResponse: vi.fn(
        (data, message, status) =>
            new Response(JSON.stringify({ result: data, error: message }), {
                status,
                headers: { 'Content-Type': 'application/json' },
            })
    ),
}))

vi.mock('./handler', () => ({
    StarbaseDB: vi.fn().mockImplementation(() => ({
        handlePreAuth: vi.fn().mockResolvedValue(null),
        handle: vi.fn().mockResolvedValue(new Response('handled')),
    })),
}))

vi.mock('./cors', () => ({
    corsPreflight: vi.fn(),
}))

vi.mock('jose', () => ({
    createRemoteJWKSet: vi.fn(() => ({ keyStore: true })),
    jwtVerify: vi.fn(),
}))

vi.mock('../plugins/websocket', () => ({
    WebSocketPlugin: vi.fn(),
}))

vi.mock('../plugins/studio', () => ({
    StudioPlugin: vi.fn(),
}))

vi.mock('../plugins/sql-macros', () => ({
    SqlMacrosPlugin: vi.fn(),
}))

vi.mock('../plugins/cdc', () => ({
    ChangeDataCapturePlugin: vi.fn().mockImplementation(() => ({
        onEvent: vi.fn(),
    })),
}))

vi.mock('../plugins/query-log', () => ({
    QueryLogPlugin: vi.fn(),
}))

vi.mock('../plugins/stats', () => ({
    StatsPlugin: vi.fn(),
}))

vi.mock('../plugins/cron', () => ({
    CronPlugin: vi.fn().mockImplementation(() => ({
        onEvent: vi.fn(),
    })),
}))

vi.mock('../plugins/interface', () => ({
    InterfacePlugin: vi.fn().mockImplementation(() => ({
        matchesRoute: vi.fn().mockReturnValue(false),
    })),
}))

function createStub() {
    return {
        init: vi.fn().mockResolvedValue({ executeQuery: vi.fn() }),
    }
}

function createEnv(overrides: Partial<Env> = {}): Env {
    return {
        ADMIN_AUTHORIZATION_TOKEN: 'admin-token',
        CLIENT_AUTHORIZATION_TOKEN: 'client-token',
        DATABASE_DURABLE_OBJECT: {
            idFromName: vi.fn().mockReturnValue('object-id'),
            get: vi.fn().mockImplementation(() => createStub()),
        } as any,
        REGION: '',
        HYPERDRIVE: undefined as any,
        ...overrides,
    }
}

const ctx = {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
} as any

beforeEach(() => {
    vi.clearAllMocks()
    ;(corsPreflight as any).mockReturnValue(undefined)
    ;(jwtVerify as any).mockReset()
    ;(InterfacePlugin as any).mockImplementation(() => ({
        matchesRoute: vi.fn().mockReturnValue(false),
    }))
})

describe('Worker fetch handler', () => {
    it('returns the CORS preflight response for OPTIONS requests', async () => {
        const preflight = new Response(null, { status: 204 })
        ;(corsPreflight as any).mockReturnValue(preflight)

        const response = await worker.fetch(
            new Request('http://localhost', { method: 'OPTIONS' }),
            createEnv(),
            ctx
        )

        expect(response).toBe(preflight)
    })

    it('continues past OPTIONS when no preflight response applies', async () => {
        const response = await worker.fetch(
            new Request('http://localhost', { method: 'OPTIONS' }),
            createEnv(),
            ctx
        )

        expect(response.status).toBe(401)
    })

    it('returns 401 when no authentication token is present', async () => {
        const response = await worker.fetch(
            new Request('http://localhost', { method: 'POST' }),
            createEnv(),
            ctx
        )

        expect(response.status).toBe(401)
        expect((await response.json()).error).toBe('Unauthorized request')
    })

    it('authenticates with the admin token and sets the admin role', async () => {
        const response = await worker.fetch(
            new Request('http://localhost', {
                method: 'POST',
                headers: { Authorization: 'Bearer admin-token' },
            }),
            createEnv(),
            ctx
        )

        expect(response.status).toBe(200)

        const config = (StarbaseDB as any).mock.calls[0][0].config
        expect(config.role).toBe('admin')
    })

    it('authenticates with the client token and keeps the client role', async () => {
        const response = await worker.fetch(
            new Request('http://localhost', {
                method: 'POST',
                headers: { Authorization: 'Bearer client-token' },
            }),
            createEnv(),
            ctx
        )

        expect(response.status).toBe(200)
        const config = (StarbaseDB as any).mock.calls[0][0].config
        expect(config.role).toBe('client')
    })

    it('returns 400 when the token matches nothing and no JWKS endpoint is set', async () => {
        const response = await worker.fetch(
            new Request('http://localhost', {
                method: 'POST',
                headers: { Authorization: 'Bearer invalid-token' },
            }),
            createEnv(),
            ctx
        )

        expect(response.status).toBe(400)
        expect((await response.json()).error).toBe('Unauthorized request')
    })

    it('accepts a valid JWT with a subject via the JWKS endpoint', async () => {
        ;(jwtVerify as any).mockResolvedValue({ payload: { sub: 'user-1' } })

        const response = await worker.fetch(
            new Request('http://localhost', {
                method: 'POST',
                headers: { Authorization: 'Bearer jwt-token' },
            }),
            createEnv({
                AUTH_JWKS_ENDPOINT: 'https://example.com/jwks',
                AUTH_ALGORITHM: 'RS256',
            }),
            ctx
        )

        expect(response.status).toBe(200)
        expect(createRemoteJWKSet).toHaveBeenCalledWith(
            new URL('https://example.com/jwks')
        )
        expect(jwtVerify).toHaveBeenCalledWith('jwt-token', expect.anything(), {
            algorithms: ['RS256'],
        })
    })

    it('rejects a JWT payload without a subject', async () => {
        ;(jwtVerify as any).mockResolvedValue({ payload: {} })

        const response = await worker.fetch(
            new Request('http://localhost', {
                method: 'POST',
                headers: { Authorization: 'Bearer jwt-token' },
            }),
            createEnv({ AUTH_JWKS_ENDPOINT: 'https://example.com/jwks' }),
            ctx
        )

        expect(response.status).toBe(400)
        expect((await response.json()).error).toBe(
            'Invalid JWT payload, subject not found.'
        )
    })

    it('reads the websocket token from the query parameter', async () => {
        const response = await worker.fetch(
            new Request('http://localhost?token=client-token&source=external', {
                method: 'GET',
                headers: { Upgrade: 'websocket' },
            }),
            createEnv(),
            ctx
        )

        expect(response.status).toBe(200)
        const dataSource = (StarbaseDB as any).mock.calls[0][0].dataSource
        expect(dataSource.source).toBe('external')
    })

    it('normalizes the source header to external, hyperdrive, or internal', async () => {
        await worker.fetch(
            new Request('http://localhost', {
                method: 'POST',
                headers: {
                    Authorization: 'Bearer client-token',
                    'X-Starbase-Source': 'Hyperdrive ',
                },
            }),
            createEnv(),
            ctx
        )
        expect((StarbaseDB as any).mock.calls[0][0].dataSource.source).toBe(
            'hyperdrive'
        )

        await worker.fetch(
            new Request('http://localhost?source=unknown', {
                method: 'POST',
                headers: { Authorization: 'Bearer client-token' },
            }),
            createEnv(),
            ctx
        )
        expect((StarbaseDB as any).mock.calls[1][0].dataSource.source).toBe(
            'internal'
        )
    })

    it('uses the region location hint when REGION is provided', async () => {
        const env = createEnv({ REGION: 'eastus' })
        await worker.fetch(
            new Request('http://localhost', {
                method: 'POST',
                headers: { Authorization: 'Bearer client-token' },
            }),
            env,
            ctx
        )

        expect(env.DATABASE_DURABLE_OBJECT.get).toHaveBeenCalledWith(
            'object-id',
            { locationHint: 'eastus' }
        )
    })

    it('returns the pre-auth response when the handler provides one', async () => {
        const preAuth = new Response('pre-auth')
        ;(StarbaseDB as any).mockImplementation(() => ({
            handlePreAuth: vi.fn().mockResolvedValue(preAuth),
            handle: vi.fn(),
        }))

        const response = await worker.fetch(
            new Request('http://localhost'),
            createEnv(),
            ctx
        )

        expect(response).toBe(preAuth)
    })

    it('serves interface plugin routes without authentication', async () => {
        ;(InterfacePlugin as any).mockImplementation(() => ({
            matchesRoute: vi.fn().mockReturnValue(true),
        }))

        const response = await worker.fetch(
            new Request('http://localhost/interior'),
            createEnv(),
            ctx
        )

        expect(response.status).toBe(200)
        await response.text()
    })

    it('configures a postgresql external data source', async () => {
        await worker.fetch(
            new Request('http://localhost', {
                method: 'POST',
                headers: { Authorization: 'Bearer client-token' },
            }),
            createEnv({
                EXTERNAL_DB_TYPE: 'postgresql',
                EXTERNAL_DB_HOST: 'db.example.com',
                EXTERNAL_DB_PORT: 5432,
                EXTERNAL_DB_USER: 'user',
                EXTERNAL_DB_PASS: 'pass',
                EXTERNAL_DB_DATABASE: 'postgres',
                EXTERNAL_DB_DEFAULT_SCHEMA: 'public',
            }),
            ctx
        )

        const external = (StarbaseDB as any).mock.calls[0][0].dataSource
            .external
        expect(external.dialect).toBe('postgresql')
        expect(external.host).toBe('db.example.com')
    })

    it('configures a mysql external data source', async () => {
        await worker.fetch(
            new Request('http://localhost', {
                method: 'POST',
                headers: { Authorization: 'Bearer client-token' },
            }),
            createEnv({
                EXTERNAL_DB_TYPE: 'mysql',
                EXTERNAL_DB_HOST: 'db.example.com',
                EXTERNAL_DB_PORT: 3306,
                EXTERNAL_DB_USER: 'user',
                EXTERNAL_DB_PASS: 'pass',
                EXTERNAL_DB_DATABASE: 'mysql',
            }),
            ctx
        )

        const external = (StarbaseDB as any).mock.calls[0][0].dataSource
            .external
        expect(external.dialect).toBe('mysql')
    })

    it('configures the cloudflare d1 sqlite provider', async () => {
        await worker.fetch(
            new Request('http://localhost', {
                method: 'POST',
                headers: { Authorization: 'Bearer client-token' },
            }),
            createEnv({
                EXTERNAL_DB_TYPE: 'sqlite',
                EXTERNAL_DB_CLOUDFLARE_API_KEY: 'cf-key',
                EXTERNAL_DB_CLOUDFLARE_ACCOUNT_ID: 'account',
                EXTERNAL_DB_CLOUDFLARE_DATABASE_ID: 'database',
            }),
            ctx
        )

        const external = (StarbaseDB as any).mock.calls[0][0].dataSource
            .external
        expect(external.provider).toBe('cloudflare-d1')
    })

    it('configures the starbase sqlite provider', async () => {
        await worker.fetch(
            new Request('http://localhost', {
                method: 'POST',
                headers: { Authorization: 'Bearer client-token' },
            }),
            createEnv({
                EXTERNAL_DB_TYPE: 'sqlite',
                EXTERNAL_DB_STARBASEDB_URI: 'https://starbase.example.com',
                EXTERNAL_DB_STARBASEDB_TOKEN: 'token',
            }),
            ctx
        )

        const external = (StarbaseDB as any).mock.calls[0][0].dataSource
            .external
        expect(external.provider).toBe('starbase')
    })

    it('configures the turso sqlite provider', async () => {
        await worker.fetch(
            new Request('http://localhost', {
                method: 'POST',
                headers: { Authorization: 'Bearer client-token' },
            }),
            createEnv({
                EXTERNAL_DB_TYPE: 'sqlite',
                EXTERNAL_DB_TURSO_URI: 'libsql://example.turso.io',
                EXTERNAL_DB_TURSO_TOKEN: 'token',
            }),
            ctx
        )

        const external = (StarbaseDB as any).mock.calls[0][0].dataSource
            .external
        expect(external.provider).toBe('turso')
    })

    it('uses the hyperdrive connection string when available', async () => {
        await worker.fetch(
            new Request('http://localhost', {
                method: 'POST',
                headers: { Authorization: 'Bearer client-token' },
            }),
            createEnv({
                HYPERDRIVE: {
                    connectionString: 'postgres://hyperdrive',
                } as any,
            }),
            ctx
        )

        const external = (StarbaseDB as any).mock.calls[0][0].dataSource
            .external
        expect(external.connectionString).toBe('postgres://hyperdrive')
    })

    it('returns a 400 error response when an unexpected error occurs', async () => {
        const env = createEnv()
        ;(env.DATABASE_DURABLE_OBJECT.idFromName as any).mockImplementation(
            () => {
                throw new Error('binding failure')
            }
        )

        const response = await worker.fetch(
            new Request('http://localhost'),
            env,
            ctx
        )

        expect(response.status).toBe(400)
        expect((await response.json()).error).toBe('binding failure')
    })

    it('returns a generic error message for non-Error exceptions', async () => {
        const env = createEnv()
        ;(env.DATABASE_DURABLE_OBJECT.idFromName as any).mockImplementation(
            () => {
                throw 'boom'
            }
        )

        const response = await worker.fetch(
            new Request('http://localhost'),
            env,
            ctx
        )

        expect(response.status).toBe(400)
        expect((await response.json()).error).toBe(
            'An unexpected error occurred'
        )
    })
})
