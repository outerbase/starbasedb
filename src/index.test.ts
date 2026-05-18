import { describe, it, expect, vi, beforeEach } from 'vitest'
import worker from './index'
import { RegionLocationHint } from './types'

describe('Worker Index', () => {
    let mockEnv: any
    let mockCtx: any
    let mockStub: any

    beforeEach(() => {
        vi.clearAllMocks()
        mockStub = {
            init: vi.fn().mockResolvedValue({}),
        }
        mockEnv = {
            REGION: RegionLocationHint.AUTO,
            DATABASE_DURABLE_OBJECT: {
                idFromName: vi.fn().mockReturnValue('mock-id'),
                get: vi.fn().mockReturnValue(mockStub),
            },
            ADMIN_AUTHORIZATION_TOKEN: 'admin-token',
            CLIENT_AUTHORIZATION_TOKEN: 'client-token',
        }
        mockCtx = {
            waitUntil: vi.fn(),
        }
    })

    it('should handle OPTIONS request (CORS)', async () => {
        const request = new Request('http://localhost', { method: 'OPTIONS' })
        const response = await worker.fetch(request, mockEnv, mockCtx)
        expect(response.status).toBe(204)
        expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
    })

    it('should return 401 if no authentication token is provided', async () => {
        const request = new Request('http://localhost')
        const response = await worker.fetch(request, mockEnv, mockCtx)
        expect(response.status).toBe(401)
        const body = await response.json()
        expect(body.message).toBe('Unauthorized request')
    })

    it('should return 400 if authentication fails', async () => {
        const request = new Request('http://localhost', {
            headers: { Authorization: 'Bearer invalid-token' },
        })
        const response = await worker.fetch(request, mockEnv, mockCtx)
        expect(response.status).toBe(400)
        const body = await response.json()
        expect(body.message).toBe('Unauthorized request')
    })

    it('should identify role as admin for admin token', async () => {
        // We can't directly check the internal 'config.role' but we can check if it proceeds to handler
        // which would fail because we didn't mock the full StarbaseDB handle method yet.
        // But we can check if it attempts to call stub.init()
        const request = new Request('http://localhost', {
            headers: { Authorization: 'Bearer admin-token' },
        })
        await worker.fetch(request, mockEnv, mockCtx)
        expect(mockEnv.DATABASE_DURABLE_OBJECT.idFromName).toHaveBeenCalledWith('sql-durable-object')
    })

    it('should handle external database configuration (PostgreSQL)', async () => {
        mockEnv.EXTERNAL_DB_TYPE = 'postgresql'
        mockEnv.EXTERNAL_DB_HOST = 'localhost'
        mockEnv.EXTERNAL_DB_PORT = 5432
        mockEnv.EXTERNAL_DB_USER = 'user'
        mockEnv.EXTERNAL_DB_PASS = 'pass'
        mockEnv.EXTERNAL_DB_DATABASE = 'db'

        const request = new Request('http://localhost', {
            headers: { Authorization: 'Bearer client-token' },
        })
        // Should proceed without error until it hits starbase.handle
        await expect(worker.fetch(request, mockEnv, mockCtx)).resolves.toBeDefined()
    })

    it('should handle WebSocket upgrade and token from search params', async () => {
        const request = new Request('http://localhost?token=client-token', {
            headers: { Upgrade: 'websocket' },
        })
        await worker.fetch(request, mockEnv, mockCtx)
        expect(mockEnv.DATABASE_DURABLE_OBJECT.idFromName).toHaveBeenCalled()
    })
})
