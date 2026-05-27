import { beforeEach, describe, expect, it, vi } from 'vitest'
import worker from './index'
import { corsPreflight } from './cors'
import { createRemoteJWKSet, jwtVerify } from 'jose'

const mocks = vi.hoisted(() => ({
    handle: vi.fn(),
    handlePreAuth: vi.fn(),
    init: vi.fn(),
    idFromName: vi.fn(),
    get: vi.fn(),
    corsPreflight: vi.fn(),
    jwtVerify: vi.fn(),
    createRemoteJWKSet: vi.fn(),
    matchesRoute: vi.fn(),
    cdcOnEvent: vi.fn(),
    cronOnEvent: vi.fn(),
    starbaseConstructor: vi.fn(),
}))

vi.mock('./cors', () => ({
    corsHeaders: {},
    corsPreflight: mocks.corsPreflight,
}))

vi.mock('jose', () => ({
    createRemoteJWKSet: mocks.createRemoteJWKSet,
    jwtVerify: mocks.jwtVerify,
}))

vi.mock('./handler', () => ({
    StarbaseDB: mocks.starbaseConstructor.mockImplementation((args) => ({
        args,
        handlePreAuth: mocks.handlePreAuth,
        handle: mocks.handle,
    })),
}))

vi.mock('./do', () => ({
    StarbaseDBDurableObject: class StarbaseDBDurableObject {},
}))

vi.mock('../plugins/websocket', () => ({
    WebSocketPlugin: vi.fn().mockImplementation(() => ({})),
}))

vi.mock('../plugins/studio', () => ({
    StudioPlugin: vi.fn().mockImplementation(() => ({})),
}))

vi.mock('../plugins/sql-macros', () => ({
    SqlMacrosPlugin: vi.fn().mockImplementation(() => ({})),
}))

vi.mock('../plugins/cdc', () => ({
    ChangeDataCapturePlugin: vi.fn().mockImplementation(() => ({
        onEvent: mocks.cdcOnEvent,
    })),
}))

vi.mock('../plugins/query-log', () => ({
    QueryLogPlugin: vi.fn().mockImplementation(() => ({})),
}))

vi.mock('../plugins/stats', () => ({
    StatsPlugin: vi.fn().mockImplementation(() => ({})),
}))

vi.mock('../plugins/cron', () => ({
    CronPlugin: vi.fn().mockImplementation(() => ({
        onEvent: mocks.cronOnEvent,
    })),
}))

vi.mock('../plugins/interface', () => ({
    InterfacePlugin: vi.fn().mockImplementation(() => ({
        matchesRoute: mocks.matchesRoute,
    })),
}))

const executionContext = {
    waitUntil: vi.fn(),
} as unknown as ExecutionContext

function createEnv(overrides: Partial<Record<string, unknown>> = {}) {
    const durableObjectStub = {
        init: mocks.init,
    }

    const env = {
        ADMIN_AUTHORIZATION_TOKEN: 'admin-token',
        CLIENT_AUTHORIZATION_TOKEN: 'client-token',
        DATABASE_DURABLE_OBJECT: {
            idFromName: mocks.idFromName,
            get: mocks.get,
        },
        REGION: 'auto',
        HYPERDRIVE: undefined,
        ...overrides,
    } as any

    mocks.idFromName.mockReturnValue('durable-object-id')
    mocks.get.mockReturnValue(durableObjectStub)
    mocks.init.mockResolvedValue({ executeQuery: vi.fn() })

    return env
}

function lastStarbaseArgs() {
    const calls = mocks.starbaseConstructor.mock.calls
    return calls[calls.length - 1]?.[0]
}

beforeEach(() => {
    vi.clearAllMocks()

    mocks.handle.mockResolvedValue(new Response('handled', { status: 202 }))
    mocks.handlePreAuth.mockResolvedValue(null)
    mocks.corsPreflight.mockReturnValue(new Response(null, { status: 204 }))
    mocks.createRemoteJWKSet.mockReturnValue('remote-jwks')
    mocks.jwtVerify.mockResolvedValue({ payload: { sub: 'user-1' } })
    mocks.matchesRoute.mockReturnValue(false)
})

describe('worker fetch', () => {
    it('returns CORS preflight before opening a Durable Object session', async () => {
        const env = createEnv()
        const response = await worker.fetch(
            new Request('https://example.com/query', { method: 'OPTIONS' }),
            env,
            executionContext
        )

        expect(response.status).toBe(204)
        expect(corsPreflight).toHaveBeenCalledOnce()
        expect(env.DATABASE_DURABLE_OBJECT.idFromName).not.toHaveBeenCalled()
    })

    it('copies verified JWT payload into the data source context', async () => {
        const env = createEnv({
            AUTH_JWKS_ENDPOINT:
                'https://auth.example.com/.well-known/jwks.json',
            AUTH_ALGORITHM: 'RS256',
        })
        vi.mocked(jwtVerify).mockResolvedValue({
            payload: { sub: 'user-123', tenant_id: 'tenant-456' },
        } as any)

        const response = await worker.fetch(
            new Request('https://example.com/query', {
                headers: { Authorization: 'Bearer jwt-token' },
            }),
            env,
            executionContext
        )

        expect(response.status).toBe(202)
        expect(createRemoteJWKSet).toHaveBeenCalledWith(
            new URL('https://auth.example.com/.well-known/jwks.json')
        )
        expect(jwtVerify).toHaveBeenCalledWith('jwt-token', 'remote-jwks', {
            algorithms: ['RS256'],
        })
        expect(lastStarbaseArgs().dataSource.context).toEqual({
            sub: 'user-123',
            tenant_id: 'tenant-456',
        })
    })

    it('promotes admin bearer requests before delegating to StarbaseDB', async () => {
        const env = createEnv()

        const response = await worker.fetch(
            new Request('https://example.com/query', {
                headers: { Authorization: 'Bearer admin-token' },
            }),
            env,
            executionContext
        )

        expect(response.status).toBe(202)
        expect(lastStarbaseArgs().config.role).toBe('admin')
        expect(mocks.handle).toHaveBeenCalledOnce()
    })

    it('uses websocket query-token authentication and source/cache request metadata', async () => {
        const env = createEnv({ REGION: 'wnam' })

        const response = await worker.fetch(
            new Request('https://example.com/socket?token=client-token', {
                headers: {
                    Upgrade: 'websocket',
                    'X-Starbase-Source': ' external ',
                    'X-Starbase-Cache': 'true',
                },
            }),
            env,
            executionContext
        )

        expect(response.status).toBe(202)
        expect(env.DATABASE_DURABLE_OBJECT.get).toHaveBeenCalledWith(
            'durable-object-id',
            { locationHint: 'wnam' }
        )
        expect(lastStarbaseArgs().dataSource).toMatchObject({
            source: 'external',
            cache: true,
        })
    })

    it('rejects requests without an authorization token before handling routes', async () => {
        const env = createEnv()

        const response = await worker.fetch(
            new Request('https://example.com/query'),
            env,
            executionContext
        )
        const body = await response.json()

        expect(response.status).toBe(401)
        expect(body.error).toBe('Unauthorized request')
        expect(mocks.handle).not.toHaveBeenCalled()
    })
})
