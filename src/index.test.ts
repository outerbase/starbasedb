import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { StarbaseDB } from './handler'
import { InterfacePlugin } from '../plugins/interface'
import worker, { Env } from './index'

vi.mock('./do', () => ({
    StarbaseDBDurableObject: class {},
}))

vi.mock('jose', () => ({
    createRemoteJWKSet: vi.fn(() => 'mock-jwks'),
    jwtVerify: vi.fn(),
}))

vi.mock('../plugins/websocket', () => ({
    WebSocketPlugin: vi.fn().mockImplementation(() => ({
        name: 'websocket',
        opts: { requiresAuth: true },
        init: vi.fn(),
    })),
}))
vi.mock('../plugins/studio', () => ({
    StudioPlugin: vi.fn().mockImplementation(() => ({
        name: 'studio',
        opts: { requiresAuth: true },
        init: vi.fn(),
    })),
}))
vi.mock('../plugins/sql-macros', () => ({
    SqlMacrosPlugin: vi.fn().mockImplementation(() => ({
        name: 'sql-macros',
        opts: { requiresAuth: true },
        init: vi.fn(),
    })),
}))
vi.mock('../plugins/cdc', () => ({
    ChangeDataCapturePlugin: vi.fn().mockImplementation(() => ({
        name: 'cdc',
        opts: { requiresAuth: true },
        onEvent: vi.fn(),
        init: vi.fn(),
    })),
}))
vi.mock('../plugins/query-log', () => ({
    QueryLogPlugin: vi.fn().mockImplementation(() => ({
        name: 'query-log',
        opts: { requiresAuth: true },
        init: vi.fn(),
    })),
}))
vi.mock('../plugins/stats', () => ({
    StatsPlugin: vi.fn().mockImplementation(() => ({
        name: 'stats',
        opts: { requiresAuth: true },
        init: vi.fn(),
    })),
}))
vi.mock('../plugins/cron', () => ({
    CronPlugin: vi.fn().mockImplementation(() => ({
        name: 'cron',
        opts: { requiresAuth: true },
        onEvent: vi.fn(),
        init: vi.fn(),
    })),
}))
vi.mock('../plugins/interface', () => ({
    InterfacePlugin: vi.fn().mockImplementation(() => ({
        name: 'interface',
        opts: { requiresAuth: true },
        matchesRoute: vi.fn(() => false),
        init: vi.fn(),
    })),
}))

describe('Worker Entrypoint - fetch', () => {
    let mockRpc: any
    let mockStub: any
    let mockEnv: Env
    let mockCtx: ExecutionContext

    beforeEach(() => {
        vi.clearAllMocks()
        mockRpc = {
            executeQuery: vi.fn().mockResolvedValue([]),
            getAlarm: vi.fn(),
            setAlarm: vi.fn(),
            deleteAlarm: vi.fn(),
            getStatistics: vi.fn(),
        }
        mockStub = {
            init: vi.fn().mockResolvedValue(mockRpc),
        }
        mockEnv = {
            ADMIN_AUTHORIZATION_TOKEN: 'admin-secret',
            CLIENT_AUTHORIZATION_TOKEN: 'client-secret',
            REGION: 'auto',
            DATABASE_DURABLE_OBJECT: {
                idFromName: vi.fn().mockReturnValue('do-id'),
                get: vi.fn().mockReturnValue(mockStub),
            },
            HYPERDRIVE: undefined,
        } as unknown as Env
        mockCtx = {
            waitUntil: vi.fn(),
            passThroughOnException: vi.fn(),
        } as unknown as ExecutionContext

        vi.spyOn(StarbaseDB.prototype, 'handlePreAuth').mockResolvedValue(
            undefined
        )
        vi.spyOn(StarbaseDB.prototype, 'handle').mockResolvedValue(
            new Response(JSON.stringify({ result: 'ok' }), { status: 200 })
        )
    })

    it('should respond to OPTIONS CORS preflight immediately', async () => {
        const req = new Request('http://localhost/query', { method: 'OPTIONS' })
        const res = await worker.fetch(req, mockEnv, mockCtx)
        expect(res.status).toBe(204)
        expect(mockEnv.DATABASE_DURABLE_OBJECT.get).not.toHaveBeenCalled()
    })

    it('should return 401 when Authorization header is missing', async () => {
        const req = new Request('http://localhost/query', { method: 'POST' })
        const res = await worker.fetch(req, mockEnv, mockCtx)
        const json: any = await res.json()
        expect(res.status).toBe(401)
        expect(json.error).toBe('Unauthorized request')
    })

    it('should authenticate admin bearer token and use explicit region hint', async () => {
        mockEnv.REGION = 'wnam'
        const req = new Request('http://localhost/query', {
            method: 'POST',
            headers: {
                Authorization: 'Bearer admin-secret',
                'X-Starbase-Cache': 'true',
            },
        })
        const res = await worker.fetch(req, mockEnv, mockCtx)
        expect(res.status).toBe(200)
        expect(mockEnv.DATABASE_DURABLE_OBJECT.get).toHaveBeenCalledWith(
            'do-id',
            { locationHint: 'wnam' }
        )
    })

    it('should authenticate client token via WebSocket query param', async () => {
        const req = new Request(
            'http://localhost/ws?token=client-secret&source=internal',
            {
                headers: { Upgrade: 'websocket' },
            }
        )
        const res = await worker.fetch(req, mockEnv, mockCtx)
        expect(res.status).toBe(200)
    })

    it('should reject unknown token with 400 when JWKS is not configured', async () => {
        const req = new Request('http://localhost/query', {
            method: 'POST',
            headers: { Authorization: 'Bearer bad-token' },
        })
        const res = await worker.fetch(req, mockEnv, mockCtx)
        const json: any = await res.json()
        expect(res.status).toBe(400)
        expect(json.error).toBe('Unauthorized request')
    })

    it('should authenticate valid JWT via JWKS endpoint and reject missing sub', async () => {
        mockEnv.AUTH_JWKS_ENDPOINT =
            'https://auth.example.com/.well-known/jwks.json'
        mockEnv.AUTH_ALGORITHM = 'RS256'
        vi.mocked(jwtVerify).mockResolvedValueOnce({
            payload: { sub: 'user-42' },
        } as any)

        const okReq = new Request('http://localhost/query', {
            method: 'POST',
            headers: { Authorization: 'Bearer jwt-token' },
        })
        const okRes = await worker.fetch(okReq, mockEnv, mockCtx)
        expect(okRes.status).toBe(200)
        expect(createRemoteJWKSet).toHaveBeenCalled()

        vi.mocked(jwtVerify).mockResolvedValueOnce({ payload: {} } as any)
        const badReq = new Request('http://localhost/query', {
            method: 'POST',
            headers: { Authorization: 'Bearer jwt-no-sub' },
        })
        const badRes = await worker.fetch(badReq, mockEnv, mockCtx)
        expect(badRes.status).toBe(400)
        expect(((await badRes.json()) as any).error).toBe(
            'Invalid JWT payload, subject not found.'
        )
    })

    it('should return pre-auth plugin response without checking bearer token', async () => {
        vi.spyOn(StarbaseDB.prototype, 'handlePreAuth').mockResolvedValueOnce(
            new Response('preauth-ok', { status: 200 })
        )
        const req = new Request('http://localhost/public')
        const res = await worker.fetch(req, mockEnv, mockCtx)
        expect(res.status).toBe(200)
        expect(await res.text()).toBe('preauth-ok')
    })

    it('should bypass token auth when InterfacePlugin matches route', async () => {
        vi.mocked(InterfacePlugin).mockImplementationOnce(
            () =>
                ({
                    name: 'interface',
                    opts: { requiresAuth: true },
                    matchesRoute: vi.fn(() => true),
                    init: vi.fn(),
                }) as any
        )
        const req = new Request('http://localhost/ui')
        const res = await worker.fetch(req, mockEnv, mockCtx)
        expect(res.status).toBe(200)
    })

    it('should configure external postgresql, mysql, sqlite providers, and hyperdrive', async () => {
        const scenarios: Partial<Env>[] = [
            {
                EXTERNAL_DB_TYPE: 'postgresql',
                EXTERNAL_DB_HOST: 'pg.local',
                EXTERNAL_DB_PORT: 5432,
                EXTERNAL_DB_USER: 'u',
                EXTERNAL_DB_PASS: 'p',
                EXTERNAL_DB_DATABASE: 'db',
            },
            {
                EXTERNAL_DB_TYPE: 'mysql',
                EXTERNAL_DB_HOST: 'mysql.local',
                EXTERNAL_DB_PORT: 3306,
                EXTERNAL_DB_USER: 'u',
                EXTERNAL_DB_PASS: 'p',
                EXTERNAL_DB_DATABASE: 'db',
            },
            {
                EXTERNAL_DB_TYPE: 'sqlite',
                EXTERNAL_DB_CLOUDFLARE_API_KEY: 'cf-key',
                EXTERNAL_DB_CLOUDFLARE_ACCOUNT_ID: 'acc',
                EXTERNAL_DB_CLOUDFLARE_DATABASE_ID: 'd1',
                EXTERNAL_DB_STARBASEDB_URI: 'https://sb.local',
                EXTERNAL_DB_STARBASEDB_TOKEN: 'tok',
                EXTERNAL_DB_TURSO_URI: 'libsql://turso.local',
                EXTERNAL_DB_TURSO_TOKEN: 'turso-tok',
            },
            {
                HYPERDRIVE: {
                    connectionString: 'postgres://user:pass@hd/db',
                } as any,
            },
        ]

        for (const [idx, extra] of scenarios.entries()) {
            const env = { ...mockEnv, ...extra } as Env
            const sourceHeader = idx === 3 ? 'hyperdrive' : 'external'
            const req = new Request('http://localhost/query', {
                method: 'POST',
                headers: {
                    Authorization: 'Bearer admin-secret',
                    'X-Starbase-Source': sourceHeader,
                },
            })
            const res = await worker.fetch(req, env, mockCtx)
            expect(res.status).toBe(200)
        }
    })

    it('should return 400 error response when Durable Object init throws', async () => {
        mockStub.init.mockRejectedValueOnce(new Error('DO init crashed'))
        const req = new Request('http://localhost/query', {
            method: 'POST',
            headers: { Authorization: 'Bearer admin-secret' },
        })
        const res = await worker.fetch(req, mockEnv, mockCtx)
        const json: any = await res.json()
        expect(res.status).toBe(400)
        expect(json.error).toBe('DO init crashed')
    })
})
