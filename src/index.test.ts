import { describe, it, expect, vi, beforeEach } from 'vitest'
import worker, { type Env } from './index'
import { corsPreflight } from './cors'
import { StarbaseDB } from './handler'

vi.mock('cloudflare:workers', () => ({
    DurableObject: class MockDurableObject {},
}))

vi.mock('./cors', () => ({
    corsPreflight: vi.fn(),
    corsHeaders: {
        'Access-Control-Allow-Origin': '*',
    },
}))

vi.mock('./handler', () => {
    return {
        StarbaseDB: vi.fn().mockImplementation(() => ({
            handlePreAuth: vi.fn().mockResolvedValue(null),
            handle: vi
                .fn()
                .mockResolvedValue(new Response('ok', { status: 200 })),
        })),
        StarbaseDBConfiguration: {},
    }
})

let mockEnv: Env
let mockCtx: ExecutionContext
let mockStub: any

beforeEach(() => {
    vi.clearAllMocks()

    mockStub = {
        init: vi.fn().mockResolvedValue({
            executeQuery: vi.fn().mockResolvedValue([]),
        }),
    }

    mockEnv = {
        ADMIN_AUTHORIZATION_TOKEN: 'admin-token-123',
        CLIENT_AUTHORIZATION_TOKEN: 'client-token-456',
        REGION: 'auto',
        DATABASE_DURABLE_OBJECT: {
            idFromName: vi.fn().mockReturnValue('mock-id'),
            get: vi.fn().mockReturnValue(mockStub),
        } as any,
    }

    mockCtx = {
        waitUntil: vi.fn(),
        passThroughOnException: vi.fn(),
    } as any
})

describe('Worker Fetch Handler (src/index.ts)', () => {
    it('should return CORS preflight response for OPTIONS requests', async () => {
        vi.mocked(corsPreflight).mockReturnValueOnce(
            new Response(null, { status: 204 })
        )

        const request = new Request('https://api.starbasedb.com/query', {
            method: 'OPTIONS',
        })

        const response = await worker.fetch(request, mockEnv, mockCtx)
        expect(response.status).toBe(204)
        expect(corsPreflight).toHaveBeenCalled()
    })

    it('should return 401 if authorization token is missing', async () => {
        const request = new Request('https://api.starbasedb.com/query', {
            method: 'POST',
        })

        const response = await worker.fetch(request, mockEnv, mockCtx)
        expect(response.status).toBe(401)
        const body = (await response.json()) as any
        expect(body.error).toBe('Unauthorized request')
    })

    it('should authenticate successfully with ADMIN_AUTHORIZATION_TOKEN', async () => {
        const request = new Request('https://api.starbasedb.com/query', {
            method: 'POST',
            headers: {
                Authorization: 'Bearer admin-token-123',
            },
        })

        const response = await worker.fetch(request, mockEnv, mockCtx)
        expect(response.status).toBe(200)
    })

    it('should authenticate successfully with CLIENT_AUTHORIZATION_TOKEN', async () => {
        const request = new Request('https://api.starbasedb.com/query', {
            method: 'POST',
            headers: {
                Authorization: 'Bearer client-token-456',
            },
        })

        const response = await worker.fetch(request, mockEnv, mockCtx)
        expect(response.status).toBe(200)
    })

    it('should return 400 if token is invalid and no JWKS endpoint is set', async () => {
        const request = new Request('https://api.starbasedb.com/query', {
            method: 'POST',
            headers: {
                Authorization: 'Bearer invalid-token-xyz',
            },
        })

        const response = await worker.fetch(request, mockEnv, mockCtx)
        expect(response.status).toBe(400)
        const body = (await response.json()) as any
        expect(body.error).toBe('Unauthorized request')
    })

    it('should authenticate WebSocket requests using query param token', async () => {
        const request = new Request(
            'https://api.starbasedb.com/websocket?token=admin-token-123',
            {
                headers: {
                    Upgrade: 'websocket',
                },
            }
        )

        const response = await worker.fetch(request, mockEnv, mockCtx)
        expect(response.status).toBe(200)
    })

    it('should apply region locationHint when REGION is not auto', async () => {
        mockEnv.REGION = 'wnam'

        const request = new Request('https://api.starbasedb.com/query', {
            headers: { Authorization: 'Bearer admin-token-123' },
        })

        await worker.fetch(request, mockEnv, mockCtx)
        expect(mockEnv.DATABASE_DURABLE_OBJECT.get).toHaveBeenCalledWith(
            'mock-id',
            { locationHint: 'wnam' }
        )
    })

    it('should configure postgresql external database dataSource', async () => {
        mockEnv.EXTERNAL_DB_TYPE = 'postgresql'
        mockEnv.EXTERNAL_DB_HOST = 'pg.example.com'
        mockEnv.EXTERNAL_DB_PORT = 5432
        mockEnv.EXTERNAL_DB_USER = 'user'
        mockEnv.EXTERNAL_DB_PASS = 'pass'
        mockEnv.EXTERNAL_DB_DATABASE = 'db'

        const request = new Request('https://api.starbasedb.com/query', {
            headers: {
                Authorization: 'Bearer admin-token-123',
                'X-Starbase-Source': 'external',
            },
        })

        await worker.fetch(request, mockEnv, mockCtx)
        expect(StarbaseDB).toHaveBeenCalledWith(
            expect.objectContaining({
                dataSource: expect.objectContaining({
                    source: 'external',
                    external: expect.objectContaining({
                        dialect: 'postgresql',
                        host: 'pg.example.com',
                    }),
                }),
            })
        )
    })

    it('should configure mysql external database dataSource', async () => {
        mockEnv.EXTERNAL_DB_TYPE = 'mysql'
        mockEnv.EXTERNAL_DB_HOST = 'mysql.example.com'
        mockEnv.EXTERNAL_DB_PORT = 3306
        mockEnv.EXTERNAL_DB_USER = 'root'
        mockEnv.EXTERNAL_DB_PASS = 'secret'
        mockEnv.EXTERNAL_DB_DATABASE = 'testdb'

        const request = new Request('https://api.starbasedb.com/query', {
            headers: {
                Authorization: 'Bearer admin-token-123',
                'X-Starbase-Source': 'external',
            },
        })

        await worker.fetch(request, mockEnv, mockCtx)
        expect(StarbaseDB).toHaveBeenCalledWith(
            expect.objectContaining({
                dataSource: expect.objectContaining({
                    source: 'external',
                    external: expect.objectContaining({
                        dialect: 'mysql',
                        host: 'mysql.example.com',
                    }),
                }),
            })
        )
    })

    it('should configure cloudflare d1 external sqlite dataSource', async () => {
        mockEnv.EXTERNAL_DB_TYPE = 'sqlite'
        mockEnv.EXTERNAL_DB_CLOUDFLARE_API_KEY = 'cf-api-key'
        mockEnv.EXTERNAL_DB_CLOUDFLARE_ACCOUNT_ID = 'cf-acc-1'
        mockEnv.EXTERNAL_DB_CLOUDFLARE_DATABASE_ID = 'cf-db-1'

        const request = new Request('https://api.starbasedb.com/query', {
            headers: {
                Authorization: 'Bearer admin-token-123',
                'X-Starbase-Source': 'external',
            },
        })

        await worker.fetch(request, mockEnv, mockCtx)
        expect(StarbaseDB).toHaveBeenCalledWith(
            expect.objectContaining({
                dataSource: expect.objectContaining({
                    source: 'external',
                    external: expect.objectContaining({
                        dialect: 'sqlite',
                        provider: 'cloudflare-d1',
                        apiKey: 'cf-api-key',
                    }),
                }),
            })
        )
    })

    it('should configure turso external sqlite dataSource', async () => {
        mockEnv.EXTERNAL_DB_TYPE = 'sqlite'
        mockEnv.EXTERNAL_DB_TURSO_URI = 'libsql://test.turso.io'
        mockEnv.EXTERNAL_DB_TURSO_TOKEN = 'turso-jwt'

        const request = new Request('https://api.starbasedb.com/query', {
            headers: {
                Authorization: 'Bearer admin-token-123',
                'X-Starbase-Source': 'external',
            },
        })

        await worker.fetch(request, mockEnv, mockCtx)
        expect(StarbaseDB).toHaveBeenCalledWith(
            expect.objectContaining({
                dataSource: expect.objectContaining({
                    source: 'external',
                    external: expect.objectContaining({
                        dialect: 'sqlite',
                        provider: 'turso',
                        uri: 'libsql://test.turso.io',
                    }),
                }),
            })
        )
    })

    it('should configure hyperdrive external dataSource', async () => {
        mockEnv.HYPERDRIVE = {
            connectionString: 'postgres://hd.example.com/db',
        } as any

        const request = new Request('https://api.starbasedb.com/query', {
            headers: {
                Authorization: 'Bearer admin-token-123',
                'X-Starbase-Source': 'hyperdrive',
            },
        })

        await worker.fetch(request, mockEnv, mockCtx)
        expect(StarbaseDB).toHaveBeenCalledWith(
            expect.objectContaining({
                dataSource: expect.objectContaining({
                    source: 'hyperdrive',
                    external: expect.objectContaining({
                        dialect: 'postgresql',
                        connectionString: 'postgres://hd.example.com/db',
                    }),
                }),
            })
        )
    })
})
