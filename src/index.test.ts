import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
    const state = {
        preAuthResponse: undefined as Response | undefined,
    }
    const starbaseInstances: any[] = []
    const createResponse = vi.fn(
        (result: unknown, error: string | undefined, status: number) =>
            new Response(JSON.stringify({ result, error }), {
                status,
                headers: { 'Content-Type': 'application/json' },
            })
    )
    const corsPreflight = vi.fn(
        () => new Response(null, { status: 204, headers: { 'X-Cors': 'hit' } })
    )
    const StarbaseDB = vi.fn().mockImplementation((opts) => {
        const instance = {
            opts,
            handlePreAuth: vi.fn(async () => state.preAuthResponse),
            handle: vi.fn(
                async () => new Response('starbase', { status: 200 })
            ),
        }
        starbaseInstances.push(instance)
        return instance
    })

    return {
        state,
        starbaseInstances,
        createResponse,
        corsPreflight,
        StarbaseDB,
        createRemoteJWKSet: vi.fn(() => 'jwks'),
        jwtVerify: vi.fn(async () => ({ payload: { sub: 'user-123' } })),
        interfaceMatchesRoute: vi.fn(() => false),
        webSocketPlugin: vi.fn(() => ({ name: 'websocket' })),
        studioPlugin: vi.fn(() => ({ name: 'studio' })),
        sqlMacrosPlugin: vi.fn(() => ({ name: 'sql-macros' })),
        cdcOnEvent: vi.fn(),
        cdcPlugin: vi.fn(() => ({ name: 'cdc', onEvent: mocks.cdcOnEvent })),
        queryLogPlugin: vi.fn(() => ({ name: 'query-log' })),
        statsPlugin: vi.fn(() => ({ name: 'stats' })),
        cronOnEvent: vi.fn(),
        cronPlugin: vi.fn(() => ({
            name: 'cron',
            onEvent: mocks.cronOnEvent,
        })),
        interfacePlugin: vi.fn(() => ({
            name: 'interface',
            matchesRoute: mocks.interfaceMatchesRoute,
        })),
    }
})

vi.mock('./utils', () => ({
    createResponse: mocks.createResponse,
}))

vi.mock('./cors', () => ({
    corsPreflight: mocks.corsPreflight,
}))

vi.mock('./handler', () => ({
    StarbaseDB: mocks.StarbaseDB,
}))

vi.mock('./do', () => ({
    StarbaseDBDurableObject: class MockStarbaseDBDurableObject {},
}))

vi.mock('jose', () => ({
    createRemoteJWKSet: mocks.createRemoteJWKSet,
    jwtVerify: mocks.jwtVerify,
}))

vi.mock('../plugins/websocket', () => ({
    WebSocketPlugin: mocks.webSocketPlugin,
}))

vi.mock('../plugins/studio', () => ({
    StudioPlugin: mocks.studioPlugin,
}))

vi.mock('../plugins/sql-macros', () => ({
    SqlMacrosPlugin: mocks.sqlMacrosPlugin,
}))

vi.mock('../plugins/cdc', () => ({
    ChangeDataCapturePlugin: mocks.cdcPlugin,
}))

vi.mock('../plugins/query-log', () => ({
    QueryLogPlugin: mocks.queryLogPlugin,
}))

vi.mock('../plugins/stats', () => ({
    StatsPlugin: mocks.statsPlugin,
}))

vi.mock('../plugins/cron', () => ({
    CronPlugin: mocks.cronPlugin,
}))

vi.mock('../plugins/interface', () => ({
    InterfacePlugin: mocks.interfacePlugin,
}))

import worker from './index'

function makeRuntime(overrides: Record<string, unknown> = {}) {
    const rpc = { executeQuery: vi.fn() }
    const stub = { init: vi.fn(async () => rpc) }
    const namespace = {
        idFromName: vi.fn(() => 'durable-id'),
        get: vi.fn(() => stub),
    }
    const env = {
        ADMIN_AUTHORIZATION_TOKEN: 'admin-secret',
        CLIENT_AUTHORIZATION_TOKEN: 'client-secret',
        DATABASE_DURABLE_OBJECT: namespace,
        REGION: undefined,
        HYPERDRIVE: {},
        ...overrides,
    } as any
    const ctx = { waitUntil: vi.fn() } as any

    return { env, ctx, namespace, stub, rpc }
}

beforeEach(() => {
    vi.clearAllMocks()
    mocks.state.preAuthResponse = undefined
    mocks.starbaseInstances.length = 0
    mocks.interfaceMatchesRoute.mockReturnValue(false)
    mocks.jwtVerify.mockResolvedValue({ payload: { sub: 'user-123' } })
})

describe('Worker fetch entrypoint', () => {
    it('returns CORS preflight before opening a Durable Object session', async () => {
        const { env, ctx, namespace } = makeRuntime()
        const request = new Request('https://starbasedb.test/query', {
            method: 'OPTIONS',
        })

        const response = await worker.fetch(request, env, ctx)

        expect(response.status).toBe(204)
        expect(response.headers.get('X-Cors')).toBe('hit')
        expect(mocks.corsPreflight).toHaveBeenCalledOnce()
        expect(namespace.idFromName).not.toHaveBeenCalled()
    })

    it('routes admin-token requests into StarbaseDB with internal source defaults', async () => {
        const { env, ctx, namespace, rpc } = makeRuntime({
            ENABLE_ALLOWLIST: true,
            ENABLE_RLS: false,
        })
        const request = new Request('https://starbasedb.test/query', {
            headers: { Authorization: 'Bearer admin-secret' },
        })

        const response = await worker.fetch(request, env, ctx)
        const instance = mocks.starbaseInstances[0]

        expect(response.status).toBe(200)
        expect(namespace.get).toHaveBeenCalledWith('durable-id')
        expect(mocks.StarbaseDB).toHaveBeenCalledWith(
            expect.objectContaining({
                dataSource: expect.objectContaining({
                    rpc,
                    source: 'internal',
                    cache: false,
                }),
                config: expect.objectContaining({
                    role: 'admin',
                    features: { allowlist: true, rls: false },
                }),
            })
        )
        expect(instance.handlePreAuth).toHaveBeenCalledWith(request, ctx)
        expect(instance.handle).toHaveBeenCalledWith(request, ctx)

        const [cdcCallback, cdcCtx] = mocks.cdcOnEvent.mock.calls[0]
        const [cronCallback, cronCtx] = mocks.cronOnEvent.mock.calls[0]
        await cdcCallback({ action: 'INSERT', schema: 'main', table: 'users' })
        await cronCallback({ name: 'nightly', cron_tab: '* * * * *' })
        expect(cdcCtx).toBe(ctx)
        expect(cronCtx).toBe(ctx)
    })

    it('builds external PostgreSQL data sources from request and env settings', async () => {
        const { env, ctx } = makeRuntime({
            EXTERNAL_DB_TYPE: 'postgresql',
            EXTERNAL_DB_HOST: 'db.example.com',
            EXTERNAL_DB_PORT: 5432,
            EXTERNAL_DB_USER: 'starbase',
            EXTERNAL_DB_PASS: 'secret',
            EXTERNAL_DB_DATABASE: 'app',
            EXTERNAL_DB_DEFAULT_SCHEMA: 'tenant_a',
        })
        const request = new Request('https://starbasedb.test/query', {
            headers: {
                Authorization: 'Bearer client-secret',
                'X-Starbase-Source': ' external ',
                'X-Starbase-Cache': 'true',
            },
        })

        await worker.fetch(request, env, ctx)

        expect(mocks.StarbaseDB).toHaveBeenCalledWith(
            expect.objectContaining({
                dataSource: expect.objectContaining({
                    source: 'external',
                    cache: true,
                    external: {
                        dialect: 'postgresql',
                        host: 'db.example.com',
                        port: 5432,
                        user: 'starbase',
                        password: 'secret',
                        database: 'app',
                        defaultSchema: 'tenant_a',
                    },
                }),
                config: expect.objectContaining({ role: 'client' }),
            })
        )
    })

    it('uses region hints and Hyperdrive connection strings when requested', async () => {
        const { env, ctx, namespace } = makeRuntime({
            REGION: 'wnam',
            HYPERDRIVE: { connectionString: 'postgres://hyperdrive' },
        })
        const request = new Request(
            'https://starbasedb.test/query?source=hyperdrive',
            {
                headers: { Authorization: 'Bearer client-secret' },
            }
        )

        await worker.fetch(request, env, ctx)

        expect(namespace.get).toHaveBeenCalledWith('durable-id', {
            locationHint: 'wnam',
        })
        expect(mocks.StarbaseDB).toHaveBeenCalledWith(
            expect.objectContaining({
                dataSource: expect.objectContaining({
                    source: 'hyperdrive',
                    external: {
                        dialect: 'postgresql',
                        connectionString: 'postgres://hyperdrive',
                    },
                }),
            })
        )
    })

    it('builds MySQL external data sources', async () => {
        const { env, ctx } = makeRuntime({
            EXTERNAL_DB_TYPE: 'mysql',
            EXTERNAL_DB_HOST: 'mysql.example.com',
            EXTERNAL_DB_PORT: 3306,
            EXTERNAL_DB_USER: 'starbase',
            EXTERNAL_DB_PASS: 'secret',
            EXTERNAL_DB_DATABASE: 'app',
        })
        const request = new Request('https://starbasedb.test/query', {
            headers: {
                Authorization: 'Bearer client-secret',
                'X-Starbase-Source': 'external',
            },
        })

        await worker.fetch(request, env, ctx)

        expect(mocks.StarbaseDB).toHaveBeenCalledWith(
            expect.objectContaining({
                dataSource: expect.objectContaining({
                    external: expect.objectContaining({
                        dialect: 'mysql',
                        host: 'mysql.example.com',
                        port: 3306,
                    }),
                }),
            })
        )
    })

    it('builds SQLite provider data sources from optional env settings', async () => {
        const { env, ctx } = makeRuntime({
            EXTERNAL_DB_TYPE: 'sqlite',
            EXTERNAL_DB_CLOUDFLARE_API_KEY: 'cf-key',
            EXTERNAL_DB_CLOUDFLARE_ACCOUNT_ID: 'account-id',
            EXTERNAL_DB_CLOUDFLARE_DATABASE_ID: 'database-id',
            EXTERNAL_DB_STARBASEDB_URI: 'https://starbase.example.com',
            EXTERNAL_DB_STARBASEDB_TOKEN: 'starbase-token',
            EXTERNAL_DB_TURSO_URI: 'libsql://turso.example.com',
            EXTERNAL_DB_TURSO_TOKEN: 'turso-token',
            EXTERNAL_DB_DEFAULT_SCHEMA: 'main',
        })
        const request = new Request('https://starbasedb.test/query', {
            headers: {
                Authorization: 'Bearer client-secret',
                'X-Starbase-Source': 'external',
            },
        })

        await worker.fetch(request, env, ctx)

        expect(mocks.StarbaseDB).toHaveBeenCalledWith(
            expect.objectContaining({
                dataSource: expect.objectContaining({
                    external: {
                        dialect: 'sqlite',
                        provider: 'turso',
                        uri: 'libsql://turso.example.com',
                        token: 'turso-token',
                        defaultSchema: 'main',
                    },
                }),
            })
        )
    })

    it('returns pre-auth plugin responses before authentication checks', async () => {
        const { env, ctx } = makeRuntime()
        mocks.state.preAuthResponse = new Response('plugin', { status: 202 })
        const request = new Request('https://starbasedb.test/public')

        const response = await worker.fetch(request, env, ctx)
        const instance = mocks.starbaseInstances[0]

        expect(response.status).toBe(202)
        expect(await response.text()).toBe('plugin')
        expect(instance.handlePreAuth).toHaveBeenCalledWith(request, ctx)
        expect(instance.handle).not.toHaveBeenCalled()
    })

    it('lets interface routes bypass bearer authentication', async () => {
        const { env, ctx } = makeRuntime()
        mocks.interfaceMatchesRoute.mockReturnValue(true)
        const request = new Request('https://starbasedb.test/app')

        const response = await worker.fetch(request, env, ctx)
        const instance = mocks.starbaseInstances[0]

        expect(response.status).toBe(200)
        expect(mocks.interfaceMatchesRoute).toHaveBeenCalledWith('/app')
        expect(instance.handle).toHaveBeenCalledWith(request, ctx)
        expect(mocks.createResponse).not.toHaveBeenCalledWith(
            undefined,
            'Unauthorized request',
            401
        )
    })

    it('returns 401 when protected routes have no auth token', async () => {
        const { env, ctx } = makeRuntime()
        const request = new Request('https://starbasedb.test/query')

        const response = await worker.fetch(request, env, ctx)
        const instance = mocks.starbaseInstances[0]

        expect(response.status).toBe(401)
        expect(await response.json()).toEqual({
            error: 'Unauthorized request',
        })
        expect(instance.handle).not.toHaveBeenCalled()
    })

    it('reads websocket auth tokens from the URL query string', async () => {
        const { env, ctx } = makeRuntime()
        const request = new Request(
            'https://starbasedb.test/socket?token=client-secret',
            {
                headers: { Upgrade: 'websocket' },
            }
        )

        const response = await worker.fetch(request, env, ctx)
        const instance = mocks.starbaseInstances[0]

        expect(response.status).toBe(200)
        expect(instance.handle).toHaveBeenCalledWith(request, ctx)
    })

    it('rejects unknown bearer tokens when JWT auth is not configured', async () => {
        const { env, ctx } = makeRuntime()
        const request = new Request('https://starbasedb.test/query', {
            headers: { Authorization: 'Bearer unknown-token' },
        })

        const response = await worker.fetch(request, env, ctx)
        const instance = mocks.starbaseInstances[0]

        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({
            error: 'Unauthorized request',
        })
        expect(instance.handle).not.toHaveBeenCalled()
    })

    it('accepts JWT auth when a JWKS endpoint is configured', async () => {
        const { env, ctx } = makeRuntime({
            AUTH_JWKS_ENDPOINT: 'https://issuer.example.com/.well-known/jwks',
            AUTH_ALGORITHM: 'RS256',
        })
        const request = new Request('https://starbasedb.test/query', {
            headers: { Authorization: 'Bearer jwt-token' },
        })

        const response = await worker.fetch(request, env, ctx)

        expect(response.status).toBe(200)
        expect(mocks.createRemoteJWKSet).toHaveBeenCalledWith(
            new URL('https://issuer.example.com/.well-known/jwks')
        )
        expect(mocks.jwtVerify).toHaveBeenCalledWith('jwt-token', 'jwks', {
            algorithms: ['RS256'],
        })
    })

    it('returns 400 when JWT auth fails', async () => {
        const { env, ctx } = makeRuntime({
            AUTH_JWKS_ENDPOINT: 'https://issuer.example.com/jwks',
        })
        mocks.jwtVerify.mockResolvedValueOnce({ payload: {} })
        const request = new Request('https://starbasedb.test/query', {
            headers: { Authorization: 'Bearer bad-jwt' },
        })

        const response = await worker.fetch(request, env, ctx)
        const instance = mocks.starbaseInstances[0]

        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({
            error: 'Invalid JWT payload, subject not found.',
        })
        expect(instance.handle).not.toHaveBeenCalled()
    })

    it('wraps top-level runtime errors in a JSON 400 response', async () => {
        const { env, ctx, namespace } = makeRuntime()
        namespace.idFromName.mockImplementationOnce(() => {
            throw new Error('Durable Object unavailable')
        })

        const response = await worker.fetch(
            new Request('https://starbasedb.test/query'),
            env,
            ctx
        )

        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({
            error: 'Durable Object unavailable',
        })
    })
})
