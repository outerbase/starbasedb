import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ClerkPlugin } from './index'
import { Hono } from 'hono'
import type { DataSource } from '../../src/types'
import { Webhook } from 'svix'
import { jwtVerify, importSPKI } from 'jose'

vi.mock('svix', () => {
    return {
        Webhook: vi.fn().mockImplementation(() => ({
            verify: vi.fn(),
        })),
    }
})

vi.mock('jose', () => {
    return {
        importSPKI: vi.fn().mockResolvedValue('mock-public-key'),
        jwtVerify: vi.fn(),
    }
})

describe('ClerkPlugin', () => {
    let plugin: ClerkPlugin
    let mockDataSource: DataSource
    let mockVerify: any

    beforeEach(() => {
        vi.clearAllMocks()

        mockDataSource = {
            source: 'internal',
            rpc: {
                executeQuery: vi.fn().mockResolvedValue([]),
            } as any,
        }

        mockVerify = vi.fn()
        vi.mocked(Webhook).mockImplementation(
            () =>
                ({
                    verify: mockVerify,
                }) as any
        )

        plugin = new ClerkPlugin({
            clerkSigningSecret: 'whsec_test_secret_12345',
            clerkInstanceId: 'inst_123',
            clerkSessionPublicKey: 'mock-spki-key',
            verifySessions: true,
            permittedOrigins: ['https://example.com'],
            dataSource: mockDataSource,
        })
    })

    describe('Constructor & Configuration', () => {
        it('should throw an error if clerkSigningSecret is missing', () => {
            expect(() => {
                new ClerkPlugin({
                    clerkSigningSecret: '',
                    dataSource: mockDataSource,
                })
            }).toThrow('A signing secret is required for this plugin.')
        })

        it('should initialize with correct properties and default pathPrefix', () => {
            expect(plugin.name).toBe('starbasedb:clerk')
            expect(plugin.opts.requiresAuth).toBe(false)
            expect(plugin.pathPrefix).toBe('/clerk')
            expect(plugin.clerkInstanceId).toBe('inst_123')
        })
    })

    describe('Middleware Registration', () => {
        it('should create user and session tables on request', async () => {
            const app = new Hono<any>()
            await plugin.register(app as any)

            app.get('/test', (c) => c.text('ok'))
            const res = await app.request('http://localhost/test')

            expect(res.status).toBe(200)
            expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledTimes(2)
        })

        it('should skip session table creation when verifySessions is false', async () => {
            const noSessionPlugin = new ClerkPlugin({
                clerkSigningSecret: 'whsec_test',
                verifySessions: false,
                dataSource: mockDataSource,
            })

            const app = new Hono<any>()
            await noSessionPlugin.register(app as any)

            app.get('/test', (c) => c.text('ok'))
            await app.request('http://localhost/test')

            expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledTimes(1)
        })
    })

    describe('Webhook Endpoint (/clerk/webhook)', () => {
        it('should return 400 if required svix headers are missing', async () => {
            const app = new Hono<any>()
            await plugin.register(app as any)

            const res = await app.request('http://localhost/clerk/webhook', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({}),
            })

            expect(res.status).toBe(400)
            const body: any = await res.json()
            expect(body.error).toContain('Missing required headers')
        })

        it('should return 401 if instance ID does not match', async () => {
            mockVerify.mockReturnValue({
                type: 'user.created',
                instance_id: 'wrong_inst',
                data: { id: 'u_1' },
            })

            const app = new Hono<any>()
            await plugin.register(app as any)

            const res = await app.request('http://localhost/clerk/webhook', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'svix-id': 'msg_123',
                    'svix-signature': 'v1,sig',
                    'svix-timestamp': '1234567890',
                },
                body: JSON.stringify({}),
            })

            expect(res.status).toBe(401)
            const body: any = await res.json()
            expect(body.error).toBe('Invalid instance ID')
        })

        it('should process user.created event and upsert user', async () => {
            mockVerify.mockReturnValue({
                type: 'user.created',
                instance_id: 'inst_123',
                data: {
                    id: 'user_abc',
                    first_name: 'John',
                    last_name: 'Doe',
                    primary_email_address_id: 'email_1',
                    email_addresses: [
                        { id: 'email_1', email_address: 'john@example.com' },
                    ],
                },
            })

            const app = new Hono<any>()
            await plugin.register(app as any)

            const res = await app.request('http://localhost/clerk/webhook', {
                method: 'POST',
                headers: {
                    'svix-id': 'msg_1',
                    'svix-signature': 'sig_1',
                    'svix-timestamp': '12345',
                },
                body: JSON.stringify({ test: true }),
            })

            expect(res.status).toBe(200)
            const body: any = await res.json()
            expect(body.result.success).toBe(true)

            expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledWith({
                sql: expect.any(String),
                params: ['user_abc', 'john@example.com', 'John', 'Doe'],
            })
        })

        it('should process user.deleted event', async () => {
            mockVerify.mockReturnValue({
                type: 'user.deleted',
                instance_id: 'inst_123',
                data: { id: 'user_delete_1' },
            })

            const app = new Hono<any>()
            await plugin.register(app as any)

            const res = await app.request('http://localhost/clerk/webhook', {
                method: 'POST',
                headers: {
                    'svix-id': 'msg_1',
                    'svix-signature': 'sig_1',
                    'svix-timestamp': '12345',
                },
                body: JSON.stringify({}),
            })

            expect(res.status).toBe(200)
            expect(mockDataSource.rpc.executeQuery).toHaveBeenCalledWith({
                sql: expect.any(String),
                params: ['user_delete_1'],
            })
        })

        it('should process session.created and session.ended events', async () => {
            const app = new Hono<any>()
            await plugin.register(app as any)

            // session.created
            mockVerify.mockReturnValueOnce({
                type: 'session.created',
                instance_id: 'inst_123',
                data: { id: 'sess_1', user_id: 'usr_1' },
            })

            const res1 = await app.request('http://localhost/clerk/webhook', {
                method: 'POST',
                headers: {
                    'svix-id': 'msg_1',
                    'svix-signature': 'sig_1',
                    'svix-timestamp': '12345',
                },
                body: JSON.stringify({}),
            })
            expect(res1.status).toBe(200)

            // session.ended
            mockVerify.mockReturnValueOnce({
                type: 'session.ended',
                instance_id: 'inst_123',
                data: { id: 'sess_1', user_id: 'usr_1' },
            })

            const res2 = await app.request('http://localhost/clerk/webhook', {
                method: 'POST',
                headers: {
                    'svix-id': 'msg_2',
                    'svix-signature': 'sig_2',
                    'svix-timestamp': '12345',
                },
                body: JSON.stringify({}),
            })
            expect(res2.status).toBe(200)
        })

        it('should return 400 when svix verify throws an error', async () => {
            mockVerify.mockImplementation(() => {
                throw new Error('Invalid webhook signature')
            })

            const app = new Hono<any>()
            await plugin.register(app as any)

            const res = await app.request('http://localhost/clerk/webhook', {
                method: 'POST',
                headers: {
                    'svix-id': 'msg_bad',
                    'svix-signature': 'sig_bad',
                    'svix-timestamp': '12345',
                },
                body: JSON.stringify({}),
            })

            expect(res.status).toBe(400)
            const body: any = await res.json()
            expect(body.error).toContain('Webhook processing failed')
        })
    })

    describe('Authentication (authenticate & sessionExistsInDb)', () => {
        it('should return false if verifySessions is disabled or public key is missing', async () => {
            const noKeyPlugin = new ClerkPlugin({
                clerkSigningSecret: 'whsec_test',
                clerkSessionPublicKey: undefined,
                dataSource: mockDataSource,
            })

            const result = await noKeyPlugin.authenticate({
                token: 'mock-token',
            })
            expect(result).toBe(false)
        })

        it('should return false if neither cookie nor token is provided', async () => {
            const result = await plugin.authenticate({
                cookie: null,
                token: undefined,
            })
            expect(result).toBe(false)
        })

        it('should return false if token is expired', async () => {
            const now = Math.floor(Date.now() / 1000)
            vi.mocked(jwtVerify).mockResolvedValueOnce({
                payload: {
                    sub: 'usr_1',
                    sid: 'sess_1',
                    exp: now - 3600, // expired 1 hour ago
                },
            } as any)

            const result = await plugin.authenticate({ token: 'expired-token' })
            expect(result).toBe(false)
        })

        it('should return false if azp claim does not match permittedOrigins', async () => {
            const now = Math.floor(Date.now() / 1000)
            vi.mocked(jwtVerify).mockResolvedValueOnce({
                payload: {
                    sub: 'usr_1',
                    sid: 'sess_1',
                    exp: now + 3600,
                    azp: 'https://attacker.com',
                },
            } as any)

            const result = await plugin.authenticate({
                token: 'unauthorized-origin-token',
            })
            expect(result).toBe(false)
        })

        it('should return false if session does not exist in database', async () => {
            const now = Math.floor(Date.now() / 1000)
            vi.mocked(jwtVerify).mockResolvedValueOnce({
                payload: {
                    sub: 'usr_1',
                    sid: 'sess_1',
                    exp: now + 3600,
                    azp: 'https://example.com',
                },
            } as any)

            vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValueOnce([])

            const result = await plugin.authenticate({
                token: 'valid-token-no-db-session',
            })
            expect(result).toBe(false)
        })

        it('should return payload if authentication and session verification succeed', async () => {
            const now = Math.floor(Date.now() / 1000)
            const payload = {
                sub: 'usr_1',
                sid: 'sess_1',
                exp: now + 3600,
                azp: 'https://example.com',
            }

            vi.mocked(jwtVerify).mockResolvedValueOnce({ payload } as any)
            vi.mocked(mockDataSource.rpc.executeQuery).mockResolvedValueOnce([
                { id: 'sess_1' },
            ] as any)

            const result = await plugin.authenticate({
                cookie: '__session=valid_jwt_cookie_value',
            })

            expect(result).toEqual(payload)
        })

        it('should handle sessionExistsInDb catching database errors gracefully', async () => {
            vi.mocked(mockDataSource.rpc.executeQuery).mockRejectedValueOnce(
                new Error('Database connection failed')
            )

            const exists = await plugin.sessionExistsInDb({
                sub: 'usr_1',
                sid: 'sess_1',
            })
            expect(exists).toBe(false)
        })
    })
})
