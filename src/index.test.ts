import { describe, it, expect, vi } from 'vitest'
import type { DataSource } from './types'

vi.mock('jose', () => ({
    createRemoteJWKSet: vi.fn(),
    jwtVerify: vi.fn(),
}))

vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }))

vi.mock('./handler', () => {
    return {
        StarbaseDB: class {
            handlePreAuth = vi.fn().mockResolvedValue(undefined)
            handle = vi.fn().mockResolvedValue(new Response('ok'))
        },
    }
})

import worker from './index'

describe('index.ts', () => {
    it('should handle fetch requests', async () => {
        const req = new Request('http://localhost', {
            headers: { Authorization: 'Bearer admin' },
        })
        const env = {
            DATABASE_DURABLE_OBJECT: {
                idFromName: vi.fn().mockReturnValue('id'),
                get: vi.fn().mockReturnValue({
                    init: vi.fn().mockResolvedValue({ executeQuery: vi.fn() }),
                }),
            },
            ADMIN_AUTHORIZATION_TOKEN: 'admin',
            CLIENT_AUTHORIZATION_TOKEN: 'client',
            REGION: 'auto',
        }
        const res = await worker.fetch(req, env as any, {} as any)
        expect(res.status).toBe(200)
    })

    it('should handle external db env configs', async () => {
        const req = new Request('http://localhost', {
            headers: { Authorization: 'Bearer admin' },
        })
        const env = {
            DATABASE_DURABLE_OBJECT: {
                idFromName: vi.fn().mockReturnValue('id'),
                get: vi.fn().mockReturnValue({
                    init: vi.fn().mockResolvedValue({ executeQuery: vi.fn() }),
                }),
            },
            ADMIN_AUTHORIZATION_TOKEN: 'admin',
            CLIENT_AUTHORIZATION_TOKEN: 'client',
            EXTERNAL_DB_TYPE: 'postgresql',
            EXTERNAL_DB_HOST: 'host',
            EXTERNAL_DB_PORT: 5432,
            EXTERNAL_DB_USER: 'user',
            EXTERNAL_DB_PASS: 'pass',
            EXTERNAL_DB_DATABASE: 'db',
        }
        const res = await worker.fetch(req, env as any, {} as any)
        expect(res.status).toBe(200)
    })

    it('should handle auth error', async () => {
        const req = new Request('http://localhost')
        const env = {
            DATABASE_DURABLE_OBJECT: {
                idFromName: vi.fn().mockReturnValue('id'),
                get: vi.fn().mockReturnValue({
                    init: vi.fn().mockResolvedValue({ executeQuery: vi.fn() }),
                }),
            },
            ADMIN_AUTHORIZATION_TOKEN: 'wrong',
            CLIENT_AUTHORIZATION_TOKEN: 'wrong',
        }
        const res = await worker.fetch(req, env as any, {} as any)
        expect(res.status).toBe(401)
    })

    it('should handle OPTIONS preflight', async () => {
        const req = new Request('http://localhost', { method: 'OPTIONS' })
        const env = {
            DATABASE_DURABLE_OBJECT: {
                idFromName: vi.fn().mockReturnValue('id'),
                get: vi.fn().mockReturnValue({
                    init: vi.fn().mockResolvedValue({ executeQuery: vi.fn() }),
                }),
            },
        }
        const res = await worker.fetch(req, env as any, {} as any)
        expect(res.status).toBe(204)
    })

    it('should handle websockets with token param and region', async () => {
        const req = new Request(
            'http://localhost?token=client&source=external',
            {
                headers: { Upgrade: 'websocket' },
            }
        )
        const env = {
            REGION: 'WNAM',
            DATABASE_DURABLE_OBJECT: {
                idFromName: vi.fn().mockReturnValue('id'),
                get: vi.fn().mockReturnValue({
                    init: vi.fn().mockResolvedValue({ executeQuery: vi.fn() }),
                }),
            },
            ADMIN_AUTHORIZATION_TOKEN: 'admin',
            CLIENT_AUTHORIZATION_TOKEN: 'client',
            EXTERNAL_DB_TYPE: 'mysql',
            EXTERNAL_DB_HOST: 'host',
            EXTERNAL_DB_PORT: 3306,
            EXTERNAL_DB_USER: 'user',
            EXTERNAL_DB_PASS: 'pass',
            EXTERNAL_DB_DATABASE: 'db',
        }
        const res = await worker.fetch(req, env as any, {} as any)
        expect(res.status).toBe(200)
    })

    it('should handle starbase and turso configs', async () => {
        const req = new Request('http://localhost', {
            headers: { Authorization: 'Bearer admin' },
        })
        const env = {
            DATABASE_DURABLE_OBJECT: {
                idFromName: vi.fn().mockReturnValue('id'),
                get: vi.fn().mockReturnValue({
                    init: vi.fn().mockResolvedValue({ executeQuery: vi.fn() }),
                }),
            },
            ADMIN_AUTHORIZATION_TOKEN: 'admin',
            CLIENT_AUTHORIZATION_TOKEN: 'client',
            EXTERNAL_DB_TYPE: 'sqlite',
            EXTERNAL_DB_STARBASEDB_URI: 'uri',
            EXTERNAL_DB_STARBASEDB_TOKEN: 'token',
            EXTERNAL_DB_TURSO_URI: 'uri',
            EXTERNAL_DB_TURSO_TOKEN: 'token',
        }
        const res = await worker.fetch(req, env as any, {} as any)
        expect(res.status).toBe(200)
    })

    it('should handle JWT verification successfully', async () => {
        const req = new Request('http://localhost', {
            headers: { Authorization: 'Bearer test-jwt-token' },
        })
        const env = {
            DATABASE_DURABLE_OBJECT: {
                idFromName: vi.fn().mockReturnValue('id'),
                get: vi.fn().mockReturnValue({
                    init: vi.fn().mockResolvedValue({ executeQuery: vi.fn() }),
                }),
            },
            ADMIN_AUTHORIZATION_TOKEN: 'admin',
            CLIENT_AUTHORIZATION_TOKEN: 'client',
            AUTH_JWKS_ENDPOINT: 'http://jwks-url',
        }

        const jose = await import('jose')
        vi.mocked(jose.createRemoteJWKSet).mockReturnValue({} as any)
        vi.mocked(jose.jwtVerify).mockResolvedValue({
            payload: { sub: 'user-1' },
        } as any)

        const res = await worker.fetch(req, env as any, {} as any)
        expect(res.status).toBe(200)
    })

    it('should handle JWT verification failure (no sub)', async () => {
        const req = new Request('http://localhost', {
            headers: { Authorization: 'Bearer test-jwt-token' },
        })
        const env = {
            DATABASE_DURABLE_OBJECT: {
                idFromName: vi.fn().mockReturnValue('id'),
                get: vi.fn().mockReturnValue({
                    init: vi.fn().mockResolvedValue({ executeQuery: vi.fn() }),
                }),
            },
            ADMIN_AUTHORIZATION_TOKEN: 'admin',
            CLIENT_AUTHORIZATION_TOKEN: 'client',
            AUTH_JWKS_ENDPOINT: 'http://jwks-url',
        }

        const jose = await import('jose')
        vi.mocked(jose.jwtVerify).mockResolvedValue({ payload: {} } as any)

        const res = await worker.fetch(req, env as any, {} as any)
        expect(res.status).toBe(400) // JWT sub missing
    })
})
