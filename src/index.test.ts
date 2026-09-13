import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('cloudflare:workers', () => {
    return {
        DurableObject: class MockDurableObject {},
    }
})

import worker, { Env } from './index'
import { corsPreflight } from './cors'
import { jwtVerify } from 'jose'
import { StarbaseDB } from './handler'
import { InterfacePlugin } from '../plugins/interface'
import { ChangeDataCapturePlugin } from '../plugins/cdc'
import { CronPlugin } from '../plugins/cron'

vi.mock('./cors', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./cors')>()
    return {
        ...actual,
        corsPreflight: vi.fn(),
    }
})

vi.mock('jose', () => ({
    createRemoteJWKSet: vi.fn().mockReturnValue({}),
    jwtVerify: vi.fn(),
}))

const mockHandlePreAuth = vi.fn()
const mockHandle = vi.fn()
let lastStarbaseOptions: any = null

vi.mock('./handler', () => {
    return {
        StarbaseDB: vi.fn().mockImplementation((options) => {
            lastStarbaseOptions = options
            return {
                options,
                handlePreAuth: mockHandlePreAuth,
                handle: mockHandle,
            }
        }),
    }
})

describe('Worker default export fetch handler', () => {
    let mockStub: any
    let mockDoNamespace: any
    let mockEnv: Env
    let mockCtx: ExecutionContext

    beforeEach(() => {
        vi.clearAllMocks()
        lastStarbaseOptions = null
        mockHandlePreAuth.mockResolvedValue(null)
        mockHandle.mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }))

        mockStub = {
            init: vi.fn().mockResolvedValue({ query: vi.fn() }),
        }

        mockDoNamespace = {
            idFromName: vi.fn().mockReturnValue('mock-id'),
            get: vi.fn().mockReturnValue(mockStub),
        }

        mockEnv = {
            ADMIN_AUTHORIZATION_TOKEN: 'admin-secret',
            CLIENT_AUTHORIZATION_TOKEN: 'client-secret',
            DATABASE_DURABLE_OBJECT: mockDoNamespace as any,
            REGION: 'auto',
            HYPERDRIVE: {} as any,
        }

        mockCtx = {
            waitUntil: vi.fn(),
            passThroughOnException: vi.fn(),
        } as unknown as ExecutionContext
    })

    describe('CORS Preflight', () => {
        it('returns preflight response when corsPreflight returns a response', async () => {
            const preflightRes = new Response(null, { status: 204 })
            vi.mocked(corsPreflight).mockReturnValueOnce(preflightRes)

            const req = new Request('https://api.starbasedb.com/query', {
                method: 'OPTIONS',
            })
            const res = await worker.fetch(req, mockEnv, mockCtx)

            expect(res).toBe(preflightRes)
            expect(corsPreflight).toHaveBeenCalled()
        })

        it('continues request processing if corsPreflight returns null', async () => {
            vi.mocked(corsPreflight).mockReturnValueOnce(null as any)

            const req = new Request('https://api.starbasedb.com/query', {
                method: 'OPTIONS',
            })
            const res = await worker.fetch(req, mockEnv, mockCtx)

            // Should reach missing auth check (401)
            expect(res.status).toBe(401)
            const body = await res.json()
            expect(body.error).toBe('Unauthorized request')
        })
    })

    describe('Durable Object & Region Location Hint', () => {
        it('fetches DO stub with locationHint when REGION is not AUTO', async () => {
            mockEnv.REGION = 'wnam'

            const req = new Request('https://api.starbasedb.com/query', {
                headers: { Authorization: 'Bearer admin-secret' },
            })
            const res = await worker.fetch(req, mockEnv, mockCtx)

            expect(res.status).toBe(200)
            expect(mockDoNamespace.idFromName).toHaveBeenCalledWith('sql-durable-object')
            expect(mockDoNamespace.get).toHaveBeenCalledWith('mock-id', {
                locationHint: 'wnam',
            })
            expect(mockStub.init).toHaveBeenCalled()
        })

        it('fetches DO stub without locationHint when REGION is AUTO or undefined', async () => {
            delete (mockEnv as any).REGION

            const req = new Request('https://api.starbasedb.com/query', {
                headers: { Authorization: 'Bearer admin-secret' },
            })
            const res = await worker.fetch(req, mockEnv, mockCtx)

            expect(res.status).toBe(200)
            expect(mockDoNamespace.get).toHaveBeenCalledWith('mock-id')
        })
    })

    describe('Data Source Selection and Caching', () => {
        it('sets data source to external from X-Starbase-Source header', async () => {
            const req = new Request('https://api.starbasedb.com/query', {
                headers: {
                    Authorization: 'Bearer admin-secret',
                    'X-Starbase-Source': ' external ',
                    'X-Starbase-Cache': 'true',
                },
            })
            await worker.fetch(req, mockEnv, mockCtx)

            expect(lastStarbaseOptions.dataSource.source).toBe('external')
            expect(lastStarbaseOptions.dataSource.cache).toBe(true)
        })

        it('sets data source to hyperdrive from url query parameter', async () => {
            const req = new Request('https://api.starbasedb.com/query?source=hyperdrive', {
                headers: { Authorization: 'Bearer admin-secret' },
            })
            await worker.fetch(req, mockEnv, mockCtx)

            expect(lastStarbaseOptions.dataSource.source).toBe('hyperdrive')
        })

        it('defaults to internal data source when unknown or omitted', async () => {
            const req = new Request('https://api.starbasedb.com/query?source=unknown_source', {
                headers: { Authorization: 'Bearer admin-secret' },
            })
            await worker.fetch(req, mockEnv, mockCtx)

            expect(lastStarbaseOptions.dataSource.source).toBe('internal')
        })
    })

    describe('External Database Configurations', () => {
        it('configures PostgreSQL external database', async () => {
            mockEnv.EXTERNAL_DB_TYPE = 'postgresql'
            mockEnv.EXTERNAL_DB_HOST = 'db.postgres.com'
            mockEnv.EXTERNAL_DB_PORT = 5432
            mockEnv.EXTERNAL_DB_USER = 'pguser'
            mockEnv.EXTERNAL_DB_PASS = 'pgpass'
            mockEnv.EXTERNAL_DB_DATABASE = 'maindb'
            mockEnv.EXTERNAL_DB_DEFAULT_SCHEMA = 'public'

            const req = new Request('https://api.starbasedb.com/query', {
                headers: { Authorization: 'Bearer admin-secret' },
            })
            await worker.fetch(req, mockEnv, mockCtx)

            expect(lastStarbaseOptions.dataSource.external).toEqual({
                dialect: 'postgresql',
                host: 'db.postgres.com',
                port: 5432,
                user: 'pguser',
                password: 'pgpass',
                database: 'maindb',
                defaultSchema: 'public',
            })
        })

        it('configures MySQL external database', async () => {
            mockEnv.EXTERNAL_DB_TYPE = 'mysql'
            mockEnv.EXTERNAL_DB_HOST = 'db.mysql.com'
            mockEnv.EXTERNAL_DB_PORT = 3306
            mockEnv.EXTERNAL_DB_USER = 'root'
            mockEnv.EXTERNAL_DB_PASS = 'mypass'
            mockEnv.EXTERNAL_DB_DATABASE = 'store'
            mockEnv.EXTERNAL_DB_DEFAULT_SCHEMA = 'store'

            const req = new Request('https://api.starbasedb.com/query', {
                headers: { Authorization: 'Bearer admin-secret' },
            })
            await worker.fetch(req, mockEnv, mockCtx)

            expect(lastStarbaseOptions.dataSource.external).toEqual({
                dialect: 'mysql',
                host: 'db.mysql.com',
                port: 3306,
                user: 'root',
                password: 'mypass',
                database: 'store',
                defaultSchema: 'store',
            })
        })

        it('configures SQLite with Cloudflare D1 provider', async () => {
            mockEnv.EXTERNAL_DB_TYPE = 'sqlite'
            mockEnv.EXTERNAL_DB_CLOUDFLARE_API_KEY = 'cf-key'
            mockEnv.EXTERNAL_DB_CLOUDFLARE_ACCOUNT_ID = 'cf-acc'
            mockEnv.EXTERNAL_DB_CLOUDFLARE_DATABASE_ID = 'cf-db'

            const req = new Request('https://api.starbasedb.com/query', {
                headers: { Authorization: 'Bearer admin-secret' },
            })
            await worker.fetch(req, mockEnv, mockCtx)

            expect(lastStarbaseOptions.dataSource.external).toEqual({
                dialect: 'sqlite',
                provider: 'cloudflare-d1',
                apiKey: 'cf-key',
                accountId: 'cf-acc',
                databaseId: 'cf-db',
            })
        })

        it('configures SQLite with Starbase provider', async () => {
            mockEnv.EXTERNAL_DB_TYPE = 'sqlite'
            mockEnv.EXTERNAL_DB_STARBASEDB_URI = 'https://starbase.uri'
            mockEnv.EXTERNAL_DB_STARBASEDB_TOKEN = 'sb-tok'
            mockEnv.EXTERNAL_DB_DEFAULT_SCHEMA = 'main'

            const req = new Request('https://api.starbasedb.com/query', {
                headers: { Authorization: 'Bearer admin-secret' },
            })
            await worker.fetch(req, mockEnv, mockCtx)

            expect(lastStarbaseOptions.dataSource.external).toEqual({
                dialect: 'sqlite',
                provider: 'starbase',
                apiKey: 'https://starbase.uri',
                token: 'sb-tok',
                defaultSchema: 'main',
            })
        })

        it('configures SQLite with Turso provider', async () => {
            mockEnv.EXTERNAL_DB_TYPE = 'sqlite'
            mockEnv.EXTERNAL_DB_TURSO_URI = 'libsql://turso.db'
            mockEnv.EXTERNAL_DB_TURSO_TOKEN = 'turso-tok'
            mockEnv.EXTERNAL_DB_DEFAULT_SCHEMA = 'main'

            const req = new Request('https://api.starbasedb.com/query', {
                headers: { Authorization: 'Bearer admin-secret' },
            })
            await worker.fetch(req, mockEnv, mockCtx)

            expect(lastStarbaseOptions.dataSource.external).toEqual({
                dialect: 'sqlite',
                provider: 'turso',
                uri: 'libsql://turso.db',
                token: 'turso-tok',
                defaultSchema: 'main',
            })
        })

        it('configures Hyperdrive external connection', async () => {
            mockEnv.HYPERDRIVE = {
                connectionString: 'postgres://user:pass@hyperdrive.cloudflare.com/db',
            } as any

            const req = new Request('https://api.starbasedb.com/query', {
                headers: { Authorization: 'Bearer admin-secret' },
            })
            await worker.fetch(req, mockEnv, mockCtx)

            expect(lastStarbaseOptions.dataSource.external).toEqual({
                dialect: 'postgresql',
                connectionString: 'postgres://user:pass@hyperdrive.cloudflare.com/db',
            })
        })
    })

    describe('PreAuth and Interface Route Bypass', () => {
        it('returns early if starbase.handlePreAuth handles the request', async () => {
            const preAuthRes = new Response('Handled by pre-auth', { status: 200 })
            mockHandlePreAuth.mockResolvedValueOnce(preAuthRes)

            const req = new Request('https://api.starbasedb.com/preauth-check')
            const res = await worker.fetch(req, mockEnv, mockCtx)

            expect(res).toBe(preAuthRes)
            expect(mockHandlePreAuth).toHaveBeenCalled()
            expect(mockHandle).not.toHaveBeenCalled()
        })

        it('bypasses authentication checks when route matches InterfacePlugin', async () => {
            vi.spyOn(InterfacePlugin.prototype, 'matchesRoute').mockReturnValueOnce(true)

            const req = new Request('https://api.starbasedb.com/interface/dashboard')
            const res = await worker.fetch(req, mockEnv, mockCtx)

            expect(res.status).toBe(200)
            expect(mockHandle).toHaveBeenCalled()
        })
    })

    describe('Authentication', () => {
        it('returns 401 when HTTP request has no Authorization header', async () => {
            const req = new Request('https://api.starbasedb.com/query')
            const res = await worker.fetch(req, mockEnv, mockCtx)

            expect(res.status).toBe(401)
            const body = await res.json()
            expect(body.error).toBe('Unauthorized request')
        })

        it('returns 401 when WebSocket upgrade request has no token query param', async () => {
            const req = new Request('https://api.starbasedb.com/ws', {
                headers: { Upgrade: 'websocket' },
            })
            const res = await worker.fetch(req, mockEnv, mockCtx)

            expect(res.status).toBe(401)
            const body = await res.json()
            expect(body.error).toBe('Unauthorized request')
        })

        it('authorizes admin via Bearer token and updates role to admin', async () => {
            const req = new Request('https://api.starbasedb.com/query', {
                headers: { Authorization: 'Bearer admin-secret' },
            })
            const res = await worker.fetch(req, mockEnv, mockCtx)

            expect(res.status).toBe(200)
            expect(lastStarbaseOptions.config.role).toBe('admin')
            expect(mockHandle).toHaveBeenCalled()
        })

        it('authorizes client via Bearer token and keeps role as client', async () => {
            const req = new Request('https://api.starbasedb.com/query', {
                headers: { Authorization: 'Bearer client-secret' },
            })
            const res = await worker.fetch(req, mockEnv, mockCtx)

            expect(res.status).toBe(200)
            expect(lastStarbaseOptions.config.role).toBe('client')
            expect(mockHandle).toHaveBeenCalled()
        })

        it('authorizes WebSocket request via token query param', async () => {
            const req = new Request('https://api.starbasedb.com/ws?token=admin-secret', {
                headers: { Upgrade: 'websocket' },
            })
            const res = await worker.fetch(req, mockEnv, mockCtx)

            expect(res.status).toBe(200)
            expect(lastStarbaseOptions.config.role).toBe('admin')
        })

        it('authenticates valid JWT token against AUTH_JWKS_ENDPOINT', async () => {
            mockEnv.AUTH_JWKS_ENDPOINT = 'https://auth.example.com/.well-known/jwks.json'
            mockEnv.AUTH_ALGORITHM = 'RS256'
            vi.mocked(jwtVerify).mockResolvedValueOnce({
                payload: { sub: 'user_123', email: 'test@example.com' },
            } as any)

            const req = new Request('https://api.starbasedb.com/query', {
                headers: { Authorization: 'Bearer valid.jwt.token' },
            })
            const res = await worker.fetch(req, mockEnv, mockCtx)

            expect(res.status).toBe(200)
            expect(jwtVerify).toHaveBeenCalled()
        })

        it('rejects JWT without subject (sub)', async () => {
            mockEnv.AUTH_JWKS_ENDPOINT = 'https://auth.example.com/.well-known/jwks.json'
            vi.mocked(jwtVerify).mockResolvedValueOnce({
                payload: { name: 'No Subject' },
            } as any)

            const req = new Request('https://api.starbasedb.com/query', {
                headers: { Authorization: 'Bearer jwt.without.sub' },
            })
            const res = await worker.fetch(req, mockEnv, mockCtx)

            expect(res.status).toBe(400)
            const body = await res.json()
            expect(body.error).toBe('Invalid JWT payload, subject not found.')
        })

        it('rejects invalid JWT when jwtVerify throws', async () => {
            mockEnv.AUTH_JWKS_ENDPOINT = 'https://auth.example.com/.well-known/jwks.json'
            vi.mocked(jwtVerify).mockRejectedValueOnce(new Error('Signature verification failed'))

            const req = new Request('https://api.starbasedb.com/query', {
                headers: { Authorization: 'Bearer bad.token' },
            })
            const res = await worker.fetch(req, mockEnv, mockCtx)

            expect(res.status).toBe(400)
            const body = await res.json()
            expect(body.error).toBe('Signature verification failed')
        })

        it('rejects unknown token when no JWKS endpoint is configured', async () => {
            const req = new Request('https://api.starbasedb.com/query', {
                headers: { Authorization: 'Bearer unknown-token' },
            })
            const res = await worker.fetch(req, mockEnv, mockCtx)

            expect(res.status).toBe(400)
            const body = await res.json()
            expect(body.error).toBe('Unauthorized request')
        })
    })

    describe('CDC and Cron event callbacks', () => {
        it('executes CDC and Cron event listener callbacks', async () => {
            let capturedCdcCb: any = null
            let capturedCronCb: any = null

            vi.spyOn(ChangeDataCapturePlugin.prototype, 'onEvent').mockImplementation(
                (cb: any) => {
                    capturedCdcCb = cb
                }
            )
            vi.spyOn(CronPlugin.prototype, 'onEvent').mockImplementation((cb: any) => {
                capturedCronCb = cb
            })

            const req = new Request('https://api.starbasedb.com/query', {
                headers: { Authorization: 'Bearer admin-secret' },
            })
            await worker.fetch(req, mockEnv, mockCtx)

            expect(capturedCdcCb).toBeTypeOf('function')
            expect(capturedCronCb).toBeTypeOf('function')

            // Execute callbacks to cover internal functions
            await capturedCdcCb({
                action: 'INSERT',
                schema: 'public',
                table: 'users',
                data: { id: 1 },
            })
            await capturedCronCb({
                name: 'cleanup',
                cron_tab: '* * * * *',
                payload: {},
            })
        })
    })

    describe('Top-level Error Handling', () => {
        it('returns 400 when an Error is thrown in initialization', async () => {
            mockDoNamespace.idFromName.mockImplementationOnce(() => {
                throw new Error('Durable Object initialization failure')
            })

            const req = new Request('https://api.starbasedb.com/query', {
                headers: { Authorization: 'Bearer admin-secret' },
            })
            const res = await worker.fetch(req, mockEnv, mockCtx)

            expect(res.status).toBe(400)
            const body = await res.json()
            expect(body.error).toBe('Durable Object initialization failure')
        })

        it('returns 400 with fallback message when a non-Error is thrown', async () => {
            mockDoNamespace.idFromName.mockImplementationOnce(() => {
                throw 'string exception'
            })

            const req = new Request('https://api.starbasedb.com/query', {
                headers: { Authorization: 'Bearer admin-secret' },
            })
            const res = await worker.fetch(req, mockEnv, mockCtx)

            expect(res.status).toBe(400)
            const body = await res.json()
            expect(body.error).toBe('An unexpected error occurred')
        })
    })
})
