import { describe, it, expect, vi, beforeEach } from 'vitest'
import worker, { Env } from './index'
import { jwtVerify } from 'jose'

vi.mock('./do', () => ({
    StarbaseDBDurableObject: vi.fn(),
}))

const mockHandlePreAuth = vi.fn()
const mockHandle = vi.fn()

vi.mock('./handler', () => ({
    StarbaseDB: vi.fn().mockImplementation((opts) => ({
        opts,
        handlePreAuth: mockHandlePreAuth,
        handle: mockHandle,
    })),
}))

vi.mock('jose', () => ({
    createRemoteJWKSet: vi.fn(() => 'mock-jwks'),
    jwtVerify: vi.fn(),
}))

vi.mock('../plugins/websocket', () => ({
    WebSocketPlugin: vi.fn(() => ({ opts: {}, pathPrefix: '/ws' })),
}))
vi.mock('../plugins/studio', () => ({
    StudioPlugin: vi.fn(() => ({ opts: {}, pathPrefix: '/studio' })),
}))
vi.mock('../plugins/sql-macros', () => ({
    SqlMacrosPlugin: vi.fn(() => ({ opts: {} })),
}))
vi.mock('../plugins/cdc', () => ({
    ChangeDataCapturePlugin: vi.fn(() => ({
        opts: {},
        onEvent: vi.fn(),
    })),
}))
vi.mock('../plugins/query-log', () => ({
    QueryLogPlugin: vi.fn(() => ({ opts: {} })),
}))
vi.mock('../plugins/stats', () => ({
    StatsPlugin: vi.fn(() => ({ opts: {} })),
}))
vi.mock('../plugins/cron', () => ({
    CronPlugin: vi.fn(() => ({
        opts: {},
        onEvent: vi.fn(),
    })),
}))
vi.mock('../plugins/interface', () => ({
    InterfacePlugin: vi.fn(() => ({
        opts: {},
        matchesRoute: vi.fn((path: string) => path === '/ui'),
    })),
}))

describe('Worker Entrypoint & Router (src/index.ts)', () => {
    let env: Env
    let ctx: ExecutionContext
    let mockStub: any

    beforeEach(() => {
        vi.clearAllMocks()
        mockHandlePreAuth.mockResolvedValue(undefined)
        mockHandle.mockResolvedValue(
            new Response(JSON.stringify({ ok: true }), { status: 200 })
        )

        mockStub = {
            init: vi.fn().mockResolvedValue({ executeQuery: vi.fn() }),
        }

        env = {
            ADMIN_AUTHORIZATION_TOKEN: 'admin-secret',
            CLIENT_AUTHORIZATION_TOKEN: 'client-secret',
            REGION: 'auto',
            DATABASE_DURABLE_OBJECT: {
                idFromName: vi.fn(() => 'do-id' as any),
                get: vi.fn(() => mockStub),
            } as any,
            HYPERDRIVE: {} as any,
        }

        ctx = {
            waitUntil: vi.fn(),
            passThroughOnException: vi.fn(),
        } as any
    })

    it('should handle CORS preflight OPTIONS requests', async () => {
        const req = new Request('http://localhost/query', { method: 'OPTIONS' })
        const res = await worker.fetch(req, env, ctx)
        expect(res.status).toBe(204)
    })

    it('should return 401 when no Authorization token is provided', async () => {
        const req = new Request('http://localhost/query', { method: 'POST' })
        const res = await worker.fetch(req, env, ctx)
        expect(res.status).toBe(401)
    })

    it('should authenticate admin token and forward to StarbaseDB.handle', async () => {
        const req = new Request('http://localhost/query', {
            method: 'POST',
            headers: { Authorization: 'Bearer admin-secret' },
        })
        const res = await worker.fetch(req, env, ctx)
        expect(res.status).toBe(200)
        expect(mockHandle).toHaveBeenCalledTimes(1)
    })

    it('should authenticate client token and handle locationHint region', async () => {
        env.REGION = 'wnam'
        const req = new Request('http://localhost/query?source=external', {
            method: 'POST',
            headers: { Authorization: 'Bearer client-secret' },
        })
        const res = await worker.fetch(req, env, ctx)
        expect(res.status).toBe(200)
        expect(env.DATABASE_DURABLE_OBJECT.get).toHaveBeenCalledWith('do-id', {
            locationHint: 'wnam',
        })
    })

    it('should authenticate WebSocket requests via query token', async () => {
        const req = new Request(
            'http://localhost/ws?token=client-secret&source=hyperdrive',
            {
                headers: { Upgrade: 'websocket' },
            }
        )
        const res = await worker.fetch(req, env, ctx)
        expect(res.status).toBe(200)
    })

    it('should reject invalid token when AUTH_JWKS_ENDPOINT is not configured', async () => {
        const req = new Request('http://localhost/query', {
            method: 'POST',
            headers: { Authorization: 'Bearer wrong-token' },
        })
        const res = await worker.fetch(req, env, ctx)
        expect(res.status).toBe(400)
        const body = (await res.json()) as { error: string }
        expect(body.error).toBe('Unauthorized request')
    })

    it('should verify JWT via JWKS endpoint and reject missing sub', async () => {
        env.AUTH_JWKS_ENDPOINT = 'https://example.com/.well-known/jwks.json'
        env.AUTH_ALGORITHM = 'RS256'

        vi.mocked(jwtVerify).mockResolvedValueOnce({
            payload: { sub: 'user-123' },
        } as any)
        const okReq = new Request('http://localhost/query', {
            headers: { Authorization: 'Bearer valid-jwt' },
        })
        expect((await worker.fetch(okReq, env, ctx)).status).toBe(200)

        vi.mocked(jwtVerify).mockResolvedValueOnce({
            payload: {},
        } as any)
        const noSubReq = new Request('http://localhost/query', {
            headers: { Authorization: 'Bearer no-sub-jwt' },
        })
        const noSubRes = await worker.fetch(noSubReq, env, ctx)
        expect(noSubRes.status).toBe(400)
    })

    it('should return early for preAuthRequest and InterfacePlugin routes', async () => {
        mockHandlePreAuth.mockResolvedValueOnce(
            new Response('pre-auth', { status: 200 })
        )
        const preAuthReq = new Request('http://localhost/studio')
        const preAuthRes = await worker.fetch(preAuthReq, env, ctx)
        expect(await preAuthRes.text()).toBe('pre-auth')

        const uiReq = new Request('http://localhost/ui')
        const uiRes = await worker.fetch(uiReq, env, ctx)
        expect(uiRes.status).toBe(200)
    })

    it('should configure external DB sources (postgresql, mysql, sqlite providers, hyperdrive)', async () => {
        const configs: Partial<Env>[] = [
            { EXTERNAL_DB_TYPE: 'postgresql', EXTERNAL_DB_HOST: 'localhost' },
            { EXTERNAL_DB_TYPE: 'mysql', EXTERNAL_DB_HOST: 'localhost' },
            {
                EXTERNAL_DB_TYPE: 'sqlite',
                EXTERNAL_DB_CLOUDFLARE_API_KEY: 'd1-key',
            },
            {
                EXTERNAL_DB_TYPE: 'sqlite',
                EXTERNAL_DB_STARBASEDB_URI: 'sb-uri',
            },
            {
                EXTERNAL_DB_TYPE: 'sqlite',
                EXTERNAL_DB_TURSO_URI: 'libsql://turso',
            },
            {
                HYPERDRIVE: { connectionString: 'postgres://hd' } as any,
            },
        ]

        for (const extra of configs) {
            const req = new Request('http://localhost/query', {
                headers: {
                    Authorization: 'Bearer admin-secret',
                    'X-Starbase-Source': 'external',
                },
            })
            const res = await worker.fetch(req, { ...env, ...extra }, ctx)
            expect(res.status).toBe(200)
        }
    })

    it('should return 400 if an unexpected error occurs in fetch', async () => {
        mockStub.init.mockRejectedValueOnce(new Error('DO init failed'))
        const req = new Request('http://localhost/query', {
            headers: { Authorization: 'Bearer admin-secret' },
        })
        const res = await worker.fetch(req, env, ctx)
        expect(res.status).toBe(400)
        const body = (await res.json()) as { error: string }
        expect(body.error).toBe('DO init failed')
    })
})
