import { describe, it, expect, vi, beforeEach } from 'vitest'
import { corsPreflight } from './cors'
import { StarbaseDB } from './handler'
import { RegionLocationHint } from './types'
import * as jose from 'jose'

const mockHandlePreAuth = vi.fn()
const mockHandle = vi.fn()
const mockMatchesRoute = vi.fn()

vi.mock('./do', () => ({
    StarbaseDBDurableObject: class {},
}))

vi.mock('./cors', () => ({
    corsPreflight: vi.fn().mockReturnValue(new Response(null, { status: 204 })),
    corsHeaders: { 'Access-Control-Allow-Origin': '*' },
}))

vi.mock('./handler', () => ({
    StarbaseDB: vi.fn().mockImplementation((opts) => ({
        opts,
        handlePreAuth: mockHandlePreAuth,
        handle: mockHandle,
    })),
}))

vi.mock('../plugins/websocket', () => ({
    WebSocketPlugin: vi.fn().mockImplementation(() => ({ name: 'websocket' })),
}))

vi.mock('../plugins/studio', () => ({
    StudioPlugin: vi.fn().mockImplementation(() => ({ name: 'studio' })),
}))

vi.mock('../plugins/sql-macros', () => ({
    SqlMacrosPlugin: vi.fn().mockImplementation(() => ({ name: 'sql-macros' })),
}))

vi.mock('../plugins/cdc', () => ({
    ChangeDataCapturePlugin: vi.fn().mockImplementation(() => ({
        name: 'cdc',
        onEvent: vi.fn((cb) =>
            cb({ action: 'INSERT', schema: 'main', table: 'users', data: {} })
        ),
    })),
}))

vi.mock('../plugins/query-log', () => ({
    QueryLogPlugin: vi.fn().mockImplementation(() => ({ name: 'query-log' })),
}))

vi.mock('../plugins/stats', () => ({
    StatsPlugin: vi.fn().mockImplementation(() => ({ name: 'stats' })),
}))

vi.mock('../plugins/cron', () => ({
    CronPlugin: vi.fn().mockImplementation(() => ({
        name: 'cron',
        onEvent: vi.fn((cb) =>
            cb({ name: 'job', cron_tab: '* * * * *', payload: {} })
        ),
    })),
}))

vi.mock('../plugins/interface', () => ({
    InterfacePlugin: vi.fn().mockImplementation(() => ({
        name: 'interface',
        matchesRoute: mockMatchesRoute,
    })),
}))

vi.mock('jose', () => ({
    createRemoteJWKSet: vi.fn().mockReturnValue('mock-jwks'),
    jwtVerify: vi.fn(),
}))

import worker from './index'

describe('Worker Entrypoint (src/index.ts)', () => {
    let mockEnv: any
    let mockCtx: ExecutionContext
    let mockStub: any

    beforeEach(() => {
        vi.clearAllMocks()

        mockStub = {
            init: vi.fn().mockResolvedValue({ executeQuery: vi.fn() }),
        }

        mockEnv = {
            DATABASE_DURABLE_OBJECT: {
                idFromName: vi.fn().mockReturnValue('mock-do-id'),
                get: vi.fn().mockReturnValue(mockStub),
            },
            ADMIN_AUTHORIZATION_TOKEN: 'admin-secret',
            CLIENT_AUTHORIZATION_TOKEN: 'client-secret',
            OUTERBASE_API_KEY: 'ob-key',
            REGION: RegionLocationHint.AUTO,
            ENABLE_ALLOWLIST: true,
            ENABLE_RLS: true,
        }

        mockCtx = {
            waitUntil: vi.fn(),
        } as unknown as ExecutionContext

        mockHandlePreAuth.mockResolvedValue(undefined)
        mockHandle.mockResolvedValue(
            new Response('handled-ok', { status: 200 })
        )
        mockMatchesRoute.mockReturnValue(false)
    })

    it('should handle OPTIONS preflight requests immediately', async () => {
        const req = new Request('https://example.com/query', {
            method: 'OPTIONS',
        })
        const res = await worker.fetch(req, mockEnv, mockCtx)

        expect(corsPreflight).toHaveBeenCalled()
        expect(res.status).toBe(204)
    })

    it('should pass locationHint when REGION is set and not auto', async () => {
        mockEnv.REGION = RegionLocationHint.WNAM
        const req = new Request('https://example.com/query', {
            headers: { Authorization: 'Bearer admin-secret' },
        })

        const res = await worker.fetch(req, mockEnv, mockCtx)

        expect(mockEnv.DATABASE_DURABLE_OBJECT.get).toHaveBeenCalledWith(
            'mock-do-id',
            {
                locationHint: RegionLocationHint.WNAM,
            }
        )
        expect(res.status).toBe(200)
    })

    it('should configure external postgresql and mysql dataSources', async () => {
        mockEnv.EXTERNAL_DB_TYPE = 'postgresql'
        mockEnv.EXTERNAL_DB_HOST = 'db.example.com'
        mockEnv.EXTERNAL_DB_PORT = 5432
        mockEnv.EXTERNAL_DB_USER = 'postgres'
        mockEnv.EXTERNAL_DB_PASS = 'secret'
        mockEnv.EXTERNAL_DB_DATABASE = 'appdb'
        mockEnv.EXTERNAL_DB_DEFAULT_SCHEMA = 'public'

        const req = new Request('https://example.com/query', {
            headers: {
                Authorization: 'Bearer admin-secret',
                'X-Starbase-Source': 'external',
                'X-Starbase-Cache': 'true',
            },
        })

        await worker.fetch(req, mockEnv, mockCtx)

        expect(StarbaseDB).toHaveBeenLastCalledWith(
            expect.objectContaining({
                dataSource: expect.objectContaining({
                    source: 'external',
                    cache: true,
                    external: expect.objectContaining({
                        dialect: 'postgresql',
                        host: 'db.example.com',
                        port: 5432,
                    }),
                }),
            })
        )

        mockEnv.EXTERNAL_DB_TYPE = 'mysql'
        await worker.fetch(req, mockEnv, mockCtx)
        expect(StarbaseDB).toHaveBeenLastCalledWith(
            expect.objectContaining({
                dataSource: expect.objectContaining({
                    external: expect.objectContaining({
                        dialect: 'mysql',
                    }),
                }),
            })
        )
    })

    it('should configure external sqlite dataSources for cloudflare-d1, starbase, and turso', async () => {
        mockEnv.EXTERNAL_DB_TYPE = 'sqlite'
        mockEnv.EXTERNAL_DB_CLOUDFLARE_API_KEY = 'cf-key'
        mockEnv.EXTERNAL_DB_CLOUDFLARE_ACCOUNT_ID = 'cf-acc'
        mockEnv.EXTERNAL_DB_CLOUDFLARE_DATABASE_ID = 'cf-db'

        const req = new Request('https://example.com/query?source=internal', {
            headers: { Authorization: 'Bearer admin-secret' },
        })
        await worker.fetch(req, mockEnv, mockCtx)
        expect(StarbaseDB).toHaveBeenLastCalledWith(
            expect.objectContaining({
                dataSource: expect.objectContaining({
                    source: 'internal',
                    external: expect.objectContaining({
                        provider: 'cloudflare-d1',
                        accountId: 'cf-acc',
                    }),
                }),
            })
        )

        mockEnv.EXTERNAL_DB_STARBASEDB_URI = 'https://starbase.example.com'
        mockEnv.EXTERNAL_DB_STARBASEDB_TOKEN = 'sb-token'
        await worker.fetch(req, mockEnv, mockCtx)
        expect(StarbaseDB).toHaveBeenLastCalledWith(
            expect.objectContaining({
                dataSource: expect.objectContaining({
                    external: expect.objectContaining({
                        provider: 'starbase',
                        token: 'sb-token',
                    }),
                }),
            })
        )

        mockEnv.EXTERNAL_DB_TURSO_URI = 'libsql://turso.example.com'
        mockEnv.EXTERNAL_DB_TURSO_TOKEN = 'turso-token'
        await worker.fetch(req, mockEnv, mockCtx)
        expect(StarbaseDB).toHaveBeenLastCalledWith(
            expect.objectContaining({
                dataSource: expect.objectContaining({
                    external: expect.objectContaining({
                        provider: 'turso',
                        uri: 'libsql://turso.example.com',
                    }),
                }),
            })
        )
    })

    it('should configure hyperdrive dataSource when source is hyperdrive and HYPERDRIVE binding is present', async () => {
        mockEnv.HYPERDRIVE = {
            connectionString: 'postgres://user:pass@host:5432/db',
        }

        const req = new Request('https://example.com/query?source=hyperdrive', {
            headers: { Authorization: 'Bearer admin-secret' },
        })

        await worker.fetch(req, mockEnv, mockCtx)

        expect(StarbaseDB).toHaveBeenLastCalledWith(
            expect.objectContaining({
                dataSource: expect.objectContaining({
                    source: 'hyperdrive',
                    external: expect.objectContaining({
                        dialect: 'postgresql',
                        connectionString: 'postgres://user:pass@host:5432/db',
                    }),
                }),
            })
        )
    })

    it('should return preAuthRequest when handlePreAuth matches an authless plugin route', async () => {
        const preAuthRes = new Response('pre-auth-ok', { status: 200 })
        mockHandlePreAuth.mockResolvedValueOnce(preAuthRes)

        const req = new Request('https://example.com/public')
        const res = await worker.fetch(req, mockEnv, mockCtx)

        expect(res).toBe(preAuthRes)
    })

    it('should bypass token check when interfacePlugin.matchesRoute is true', async () => {
        mockMatchesRoute.mockReturnValueOnce(true)

        const req = new Request('https://example.com/ui')
        const res = await worker.fetch(req, mockEnv, mockCtx)

        expect(mockHandle).toHaveBeenCalledWith(req, mockCtx)
        expect(res.status).toBe(200)
    })

    it('should return 401 when no authorization token is provided', async () => {
        const req = new Request('https://example.com/query')
        const res = await worker.fetch(req, mockEnv, mockCtx)

        expect(res.status).toBe(401)
    })

    it('should read authentication token from query param on websocket upgrade requests', async () => {
        const req = new Request('https://example.com/ws?token=admin-secret', {
            headers: { Upgrade: 'websocket' },
        })
        const res = await worker.fetch(req, mockEnv, mockCtx)

        expect(res.status).toBe(200)
        expect(mockHandle).toHaveBeenCalledWith(req, mockCtx)
    })

    it('should authenticate client token and handle request with client role', async () => {
        const req = new Request('https://example.com/query', {
            headers: { Authorization: 'Bearer client-secret' },
        })
        const res = await worker.fetch(req, mockEnv, mockCtx)

        expect(res.status).toBe(200)
        expect(mockHandle).toHaveBeenCalledWith(req, mockCtx)
    })

    it('should verify JWT when AUTH_JWKS_ENDPOINT is configured', async () => {
        mockEnv.AUTH_JWKS_ENDPOINT =
            'https://auth.example.com/.well-known/jwks.json'
        mockEnv.AUTH_ALGORITHM = 'RS256'
        vi.mocked(jose.jwtVerify).mockResolvedValueOnce({
            payload: { sub: 'jwt-user-1' },
            protectedHeader: { alg: 'RS256' },
        } as any)

        const req = new Request('https://example.com/query', {
            headers: { Authorization: 'Bearer valid-jwt-token' },
        })
        const res = await worker.fetch(req, mockEnv, mockCtx)

        expect(jose.jwtVerify).toHaveBeenCalled()
        expect(res.status).toBe(200)
    })

    it('should return 400 when JWT payload has no sub claim', async () => {
        mockEnv.AUTH_JWKS_ENDPOINT =
            'https://auth.example.com/.well-known/jwks.json'
        vi.mocked(jose.jwtVerify).mockResolvedValueOnce({
            payload: {},
            protectedHeader: { alg: 'RS256' },
        } as any)

        const req = new Request('https://example.com/query', {
            headers: { Authorization: 'Bearer no-sub-jwt-token' },
        })
        const res = await worker.fetch(req, mockEnv, mockCtx)

        expect(res.status).toBe(400)
        const json = (await res.json()) as { error: string }
        expect(json.error).toBe('Invalid JWT payload, subject not found.')
    })

    it('should return 400 when token does not match and AUTH_JWKS_ENDPOINT is not set', async () => {
        const req = new Request('https://example.com/query', {
            headers: { Authorization: 'Bearer unknown-token' },
        })
        const res = await worker.fetch(req, mockEnv, mockCtx)

        expect(res.status).toBe(400)
        const json = (await res.json()) as { error: string }
        expect(json.error).toBe('Unauthorized request')
    })

    it('should return 400 when an unexpected exception is thrown during request handling', async () => {
        mockHandlePreAuth.mockRejectedValueOnce(new Error('Unexpected crash'))

        const req = new Request('https://example.com/query', {
            headers: { Authorization: 'Bearer admin-secret' },
        })
        const res = await worker.fetch(req, mockEnv, mockCtx)

        expect(res.status).toBe(400)
        const json = (await res.json()) as { error: string }
        expect(json.error).toBe('Unexpected crash')
    })
})
