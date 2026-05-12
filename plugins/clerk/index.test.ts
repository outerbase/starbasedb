import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClerkPlugin } from './index'
import type { StarbaseApp, StarbaseDBConfiguration } from '../../src/handler'
import type { DataSource } from '../../src/types'

const clerkMocks = vi.hoisted(() => ({
    importSPKI: vi.fn(),
    jwtVerify: vi.fn(),
    webhookVerify: vi.fn(),
    webhookConstructor: vi.fn(),
}))

vi.mock('jose', () => ({
    importSPKI: clerkMocks.importSPKI,
    jwtVerify: clerkMocks.jwtVerify,
}))

vi.mock('svix', () => ({
    Webhook: vi.fn().mockImplementation((secret: string) => {
        clerkMocks.webhookConstructor(secret)
        return { verify: clerkMocks.webhookVerify }
    }),
}))

type CapturedClerkRoutes = {
    middleware?: (_: any, next: () => Promise<void>) => Promise<void>
    webhookPath?: string
    webhookHandler?: (c: any) => Promise<Response>
}

function createDataSource(queryResult: unknown[] = []) {
    return {
        rpc: {
            executeQuery: vi.fn().mockResolvedValue(queryResult),
        },
        source: 'internal',
    } as unknown as DataSource
}

function createPlugin(opts?: {
    dataSource?: DataSource
    verifySessions?: boolean
    permittedOrigins?: string[]
    clerkInstanceId?: string
    clerkSessionPublicKey?: string
}) {
    return new ClerkPlugin({
        clerkSigningSecret: 'whsec_test',
        clerkSessionPublicKey: opts?.clerkSessionPublicKey ?? 'public-key',
        verifySessions: opts?.verifySessions,
        permittedOrigins: opts?.permittedOrigins,
        clerkInstanceId: opts?.clerkInstanceId,
        dataSource: opts?.dataSource ?? createDataSource(),
    })
}

function createAppHarness() {
    const captured: CapturedClerkRoutes = {}
    const app = {
        use: vi.fn((middleware) => {
            captured.middleware = middleware
        }),
        post: vi.fn((path, handler) => {
            captured.webhookPath = path
            captured.webhookHandler = handler
        }),
    } as unknown as StarbaseApp

    return { app, captured }
}

function createWebhookContext(opts?: {
    headers?: Record<string, string | undefined>
    body?: string
}) {
    const headers = opts?.headers ?? {
        'svix-id': 'msg_123',
        'svix-signature': 'sig_123',
        'svix-timestamp': '1710000000',
    }

    return {
        req: {
            header: vi.fn((key: string) => headers[key]),
            text: vi.fn().mockResolvedValue(opts?.body ?? '{"ok":true}'),
        },
    }
}

async function jsonBody(response: Response) {
    return response.json() as Promise<{ result?: unknown; error?: string }>
}

describe('ClerkPlugin', () => {
    let consoleError: ReturnType<typeof vi.spyOn>

    beforeEach(() => {
        vi.clearAllMocks()
        clerkMocks.importSPKI.mockResolvedValue('imported-key')
        consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    })

    afterEach(() => {
        consoleError.mockRestore()
    })

    it('requires a webhook signing secret', () => {
        expect(
            () =>
                new ClerkPlugin({
                    clerkSigningSecret: '',
                    dataSource: createDataSource(),
                })
        ).toThrow('A signing secret is required for this plugin.')
    })

    it('registers setup middleware and the Clerk webhook route', async () => {
        const dataSource = createDataSource()
        const plugin = createPlugin({ dataSource })
        const { app, captured } = createAppHarness()
        const next = vi.fn().mockResolvedValue(undefined)

        await plugin.register(app)
        await captured.middleware!({}, next)

        expect(app.use).toHaveBeenCalledTimes(1)
        expect(app.post).toHaveBeenCalledWith(
            '/clerk/webhook',
            expect.any(Function)
        )
        expect(captured.webhookPath).toBe('/clerk/webhook')
        expect(dataSource.rpc.executeQuery).toHaveBeenCalledTimes(2)
        expect(dataSource.rpc.executeQuery).toHaveBeenNthCalledWith(1, {
            sql: expect.any(String),
            params: [],
        })
        expect(dataSource.rpc.executeQuery).toHaveBeenNthCalledWith(2, {
            sql: expect.any(String),
            params: [],
        })
        expect(next).toHaveBeenCalledTimes(1)
    })

    it('skips session-table setup when session verification is disabled', async () => {
        const dataSource = createDataSource()
        const plugin = createPlugin({ dataSource, verifySessions: false })
        const { app, captured } = createAppHarness()

        await plugin.register(app)
        await captured.middleware!({}, vi.fn().mockResolvedValue(undefined))

        expect(dataSource.rpc.executeQuery).toHaveBeenCalledTimes(1)
        expect(dataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: expect.any(String),
            params: [],
        })
    })

    it('rejects webhook requests missing Svix headers', async () => {
        const plugin = createPlugin()
        const { app, captured } = createAppHarness()

        await plugin.register(app)

        const response = await captured.webhookHandler!(
            createWebhookContext({
                headers: {
                    'svix-id': undefined,
                    'svix-signature': 'sig_123',
                    'svix-timestamp': '1710000000',
                },
            })
        )
        const body = await jsonBody(response)

        expect(response.status).toBe(400)
        expect(body.error).toBe(
            'Missing required headers: svix-id, svix-signature, svix-timestamp'
        )
        expect(clerkMocks.webhookVerify).not.toHaveBeenCalled()
    })

    it('rejects webhook events for a different Clerk instance', async () => {
        const dataSource = createDataSource()
        const plugin = createPlugin({
            dataSource,
            clerkInstanceId: 'expected-instance',
        })
        const { app, captured } = createAppHarness()
        clerkMocks.webhookVerify.mockReturnValue({
            type: 'user.deleted',
            instance_id: 'other-instance',
            data: { id: 'user_1' },
        })

        await plugin.register(app)

        const response = await captured.webhookHandler!(createWebhookContext())
        const body = await jsonBody(response)

        expect(clerkMocks.webhookConstructor).toHaveBeenCalledWith('whsec_test')
        expect(response.status).toBe(401)
        expect(body.error).toBe('Invalid instance ID')
        expect(dataSource.rpc.executeQuery).not.toHaveBeenCalled()
    })

    it('upserts users from Clerk user events using the primary email', async () => {
        const dataSource = createDataSource()
        const plugin = createPlugin({ dataSource })
        const { app, captured } = createAppHarness()
        clerkMocks.webhookVerify.mockReturnValue({
            type: 'user.created',
            instance_id: 'instance_1',
            data: {
                id: 'user_1',
                first_name: 'Ada',
                last_name: 'Lovelace',
                primary_email_address_id: 'email_primary',
                email_addresses: [
                    {
                        id: 'email_other',
                        email_address: 'other@example.com',
                    },
                    {
                        id: 'email_primary',
                        email_address: 'ada@example.com',
                    },
                ],
            },
        })

        await plugin.register(app)

        const response = await captured.webhookHandler!(createWebhookContext())
        const body = await jsonBody(response)

        expect(response.status).toBe(200)
        expect(body.result).toEqual({ success: true })
        expect(dataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: expect.any(String),
            params: ['user_1', 'ada@example.com', 'Ada', 'Lovelace'],
        })
    })

    it('deletes revoked sessions with session and user identifiers', async () => {
        const dataSource = createDataSource()
        const plugin = createPlugin({ dataSource })
        const { app, captured } = createAppHarness()
        clerkMocks.webhookVerify.mockReturnValue({
            type: 'session.revoked',
            instance_id: 'instance_1',
            data: {
                id: 'sess_1',
                user_id: 'user_1',
            },
        })

        await plugin.register(app)

        const response = await captured.webhookHandler!(createWebhookContext())
        const body = await jsonBody(response)

        expect(response.status).toBe(200)
        expect(body.result).toEqual({ success: true })
        expect(dataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: expect.any(String),
            params: ['sess_1', 'user_1'],
        })
    })

    it('returns false when session authentication is disabled', async () => {
        const plugin = createPlugin({ verifySessions: false })

        await expect(plugin.authenticate({ token: 'jwt' })).resolves.toBe(false)

        expect(clerkMocks.importSPKI).not.toHaveBeenCalled()
        expect(clerkMocks.jwtVerify).not.toHaveBeenCalled()
    })

    it('authenticates cookie sessions that exist in the database', async () => {
        const now = Math.floor(Date.now() / 1000)
        const dataSource = createDataSource([{ id: 'sess_1' }])
        const plugin = createPlugin({
            dataSource,
            permittedOrigins: ['https://app.example.com'],
        })
        const payload = {
            sid: 'sess_1',
            sub: 'user_1',
            azp: 'https://app.example.com',
            exp: now + 60,
            nbf: now - 60,
        }
        clerkMocks.jwtVerify.mockResolvedValue({ payload })

        const result = await plugin.authenticate({
            cookie: '__session=cookie-token; theme=dark',
        })

        expect(clerkMocks.importSPKI).toHaveBeenCalledWith(
            'public-key',
            'RS256'
        )
        expect(clerkMocks.jwtVerify).toHaveBeenCalledWith(
            'cookie-token',
            'imported-key'
        )
        expect(dataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: expect.any(String),
            params: ['sess_1', 'user_1'],
        })
        expect(result).toBe(payload)
    })

    it('rejects sessions from unpermitted origins before reading the database', async () => {
        const dataSource = createDataSource([{ id: 'sess_1' }])
        const plugin = createPlugin({
            dataSource,
            permittedOrigins: ['https://app.example.com'],
        })
        clerkMocks.jwtVerify.mockResolvedValue({
            payload: {
                sid: 'sess_1',
                sub: 'user_1',
                azp: 'https://evil.example.com',
                exp: Math.floor(Date.now() / 1000) + 60,
            },
        })

        const result = await plugin.authenticate({ token: 'bearer-token' })

        expect(result).toBe(false)
        expect(dataSource.rpc.executeQuery).not.toHaveBeenCalled()
    })
})
