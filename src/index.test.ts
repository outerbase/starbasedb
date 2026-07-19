import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('jose', () => ({
    jwtVerify: vi.fn(),
    createRemoteJWKSet: vi.fn(),
}))

vi.mock('./handler', () => ({
    StarbaseDB: vi.fn().mockImplementation(() => ({
        handlePreAuth: vi.fn().mockResolvedValue(null),
        handle: vi.fn().mockResolvedValue(new Response('OK', { status: 200 })),
    })),
    StarbaseDBConfiguration: {},
}))

vi.mock('./do', () => ({
    StarbaseDBDurableObject: class {},
}))

vi.mock('node-sql-parser', () => ({
    Parser: class {
        astify() {
            return { type: 'select' }
        }
    },
}))

let module: any
let handler: any

beforeEach(async () => {
    vi.clearAllMocks()
    vi.resetModules()
    module = await import('./index')
    handler = module.default
})

describe('Worker Entry Point', () => {
    it('should export a fetch handler', () => {
        expect(handler).toBeDefined()
        expect(typeof handler.fetch).toBe('function')
    })

    it('should return 401 when no Authorization header is provided', async () => {
        const env = {
            ADMIN_AUTHORIZATION_TOKEN: 'admin-token',
            CLIENT_AUTHORIZATION_TOKEN: 'client-token',
            DATABASE_DURABLE_OBJECT: {
                idFromName: vi.fn().mockReturnValue('id'),
                get: vi.fn().mockReturnValue({
                    init: vi.fn().mockResolvedValue({
                        executeQuery: vi.fn(),
                    }),
                }),
            },
        }

        const request = new Request('http://localhost/api/query')
        const response = await handler.fetch(request, env, {})

        expect(response.status).toBe(401)
    })

    it('should authorize with admin token', async () => {
        const mockInit = vi.fn().mockResolvedValue({ executeQuery: vi.fn() })
        const env = {
            ADMIN_AUTHORIZATION_TOKEN: 'admin-token',
            CLIENT_AUTHORIZATION_TOKEN: 'client-token',
            DATABASE_DURABLE_OBJECT: {
                idFromName: vi.fn().mockReturnValue('id'),
                get: vi.fn().mockReturnValue({ init: mockInit }),
            },
        }

        const request = new Request('http://localhost/api/query', {
            headers: { Authorization: 'Bearer admin-token' },
        })

        const response = await handler.fetch(request, env, {})

        expect(response.status).not.toBe(401)
        expect(mockInit).toHaveBeenCalledOnce()
    })

    it('should authorize with client token', async () => {
        const mockInit = vi.fn().mockResolvedValue({ executeQuery: vi.fn() })
        const env = {
            ADMIN_AUTHORIZATION_TOKEN: 'admin-token',
            CLIENT_AUTHORIZATION_TOKEN: 'client-token',
            DATABASE_DURABLE_OBJECT: {
                idFromName: vi.fn().mockReturnValue('id'),
                get: vi.fn().mockReturnValue({ init: mockInit }),
            },
        }

        const request = new Request('http://localhost/api/query', {
            headers: { Authorization: 'Bearer client-token' },
        })

        const response = await handler.fetch(request, env, {})

        expect(response.status).not.toBe(401)
    })

    it('should handle OPTIONS preflight requests', async () => {
        const env = {
            ADMIN_AUTHORIZATION_TOKEN: 'admin-token',
            CLIENT_AUTHORIZATION_TOKEN: 'client-token',
            DATABASE_DURABLE_OBJECT: {
                idFromName: vi.fn().mockReturnValue('id'),
                get: vi.fn().mockReturnValue({
                    init: vi.fn().mockResolvedValue({ executeQuery: vi.fn() }),
                }),
            },
        }

        const request = new Request('http://localhost/api/query', {
            method: 'OPTIONS',
        })

        const response = await handler.fetch(request, env, {})

        expect([200, 204]).toContain(response.status)
    })

    it('should handle errors gracefully and return 400', async () => {
        const env = {
            ADMIN_AUTHORIZATION_TOKEN: 'admin-token',
            CLIENT_AUTHORIZATION_TOKEN: 'client-token',
            DATABASE_DURABLE_OBJECT: {
                idFromName: vi.fn().mockImplementation(() => {
                    throw new Error('DO error')
                }),
                get: vi.fn(),
            },
        }

        const request = new Request('http://localhost/api/query', {
            headers: { Authorization: 'Bearer admin-token' },
        })

        const response = await handler.fetch(request, env, {})

        expect(response.status).toBe(400)
        const json = (await response.json()) as { error?: string }
        expect(json.error).toBe('DO error')
    })
})
