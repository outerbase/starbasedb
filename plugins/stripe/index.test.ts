import { describe, it, expect, vi, beforeEach } from 'vitest'
import { StripeSubscriptionPlugin } from './index'
import { StarbaseApp } from '../../src/handler'

function createMockContext(dataSource?: any, body?: string) {
    return {
        get: vi.fn((key: string) =>
            key === 'dataSource' ? dataSource : undefined
        ),
        req: {
            json: vi.fn().mockResolvedValue({}),
            text: vi.fn().mockResolvedValue(body ?? ''),
        },
    } as any
}

type RegisteredHandler = (...args: any[]) => Promise<Response>

function createMockApp() {
    const handlers: Record<string, RegisteredHandler[]> = {}
    const middlewares: RegisteredHandler[] = []
    const app = {
        use: vi.fn((middleware: RegisteredHandler) => {
            middlewares.push(middleware)
        }),
        post: vi.fn((path: string, handler: RegisteredHandler) => {
            handlers[path] = handlers[path] || []
            handlers[path].push(handler)
        }),
    } as unknown as StarbaseApp
    return { app, handlers, middlewares }
}

function createMockDataSource(subscriptions: any[] = []) {
    return {
        rpc: {
            executeQuery: vi.fn().mockResolvedValue(subscriptions),
        },
    }
}

async function registerPlugin(opts?: { dataSource?: any }) {
    const plugin = new StripeSubscriptionPlugin({
        stripeSecretKey: 'sk_test_placeholder',
        stripeWebhookSecret: 'whsec_placeholder',
    })
    const { app, handlers, middlewares } = createMockApp()
    await plugin.register(app)
    for (const middleware of middlewares) {
        await middleware(createMockContext(opts?.dataSource), vi.fn())
    }
    return { plugin, handlers }
}

describe('StripeSubscriptionPlugin - Initialization', () => {
    it('should require a Stripe secret key', () => {
        expect(
            () => new StripeSubscriptionPlugin()
        ).toThrow('Stripe API key is required for this plugin.')
    })

    it('should register under the /stripe prefix with auth disabled for webhooks', async () => {
        const { plugin, handlers } = await registerPlugin()
        expect(plugin.pathPrefix).toBe('/stripe')
        expect(plugin.opts.requiresAuth).toBe(false)
        expect(Object.keys(handlers)).toEqual(
            expect.arrayContaining([
                '/stripe/subscribe',
                '/stripe/unsubscribe',
                '/stripe/webhook',
            ])
        )
    })
})

describe('StripeSubscriptionPlugin - unsubscribe route', () => {
    it('should reject requests missing userId with 400', async () => {
        const { handlers } = await registerPlugin()
        const handler = handlers['/stripe/unsubscribe'][0]

        const response = await handler({
            get: vi.fn(),
            req: { json: vi.fn().mockResolvedValue({}) },
        } as any)

        expect(response.status).toBe(400)
        expect(await response.text()).toBe('Missing required fields: userId')
    })

    it('should return 404 when the user has no active subscription', async () => {
        const dataSource = createMockDataSource([])
        const { handlers } = await registerPlugin({ dataSource })
        const handler = handlers['/stripe/unsubscribe'][0]

        const response = await handler({
            get: vi.fn((key: string) =>
                key === 'dataSource' ? dataSource : undefined
            ),
            req: { json: vi.fn().mockResolvedValue({ userId: 'user-1' }) },
        } as any)

        expect(response.status).toBe(404)
        expect(await response.text()).toBe('User not found')
    })

    it('should cancel the Stripe subscription and mark it deleted in SQLite', async () => {
        const dataSource = createMockDataSource([
            { stripe_subscription_id: 'sub_123' },
        ])
        const { handlers } = await registerPlugin({ dataSource })
        const handler = handlers['/stripe/unsubscribe'][0]

        const fetchMock = vi
            .fn()
            // cancelSubscription -> POST /v1/subscriptions/sub_123
            .mockResolvedValue(
                new Response(JSON.stringify({ id: 'sub_123', status: 'canceled' }), {
                    status: 200,
                })
            )
        vi.stubGlobal('fetch', fetchMock)

        const response = await handler({
            get: vi.fn((key: string) =>
                key === 'dataSource' ? dataSource : undefined
            ),
            req: { json: vi.fn().mockResolvedValue({ userId: 'user-1' }) },
        } as any)

        expect(response.status).toBe(200)
        const body = await response.json()
        expect(body.result).toEqual({ success: true })

        // cancelSubscription -> DELETE /v1/subscriptions/sub_123
        expect(fetchMock).toHaveBeenCalledWith(
            'https://api.stripe.com/v1/subscriptions/sub_123',
            expect.objectContaining({ method: 'DELETE' })
        )
        expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe(
            'Bearer sk_test_placeholder'
        )

        expect(dataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: expect.stringContaining('SET deleted_at = CURRENT_TIMESTAMP'),
            params: ['user-1'],
        })

        vi.unstubAllGlobals()
    })

    it('should surface Stripe API failures as a 500 response', async () => {
        const dataSource = createMockDataSource([
            { stripe_subscription_id: 'sub_123' },
        ])
        const { handlers } = await registerPlugin({ dataSource })
        const handler = handlers['/stripe/unsubscribe'][0]

        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue(
                new Response(JSON.stringify({ error: { message: 'nope' } }), {
                    status: 402,
                    statusText: 'Payment Required',
                })
            )
        )

        const response = await handler({
            get: vi.fn((key: string) =>
                key === 'dataSource' ? dataSource : undefined
            ),
            req: { json: vi.fn().mockResolvedValue({ userId: 'user-1' }) },
        } as any)

        expect(response.status).toBe(500)
        const body = await response.json()
        expect(body.error).toContain('Failed to subscribe')

        vi.unstubAllGlobals()
    })
})

describe('StripeSubscriptionPlugin - webhook route', () => {
    let dataSource: ReturnType<typeof createMockDataSource>

    beforeEach(async () => {
        dataSource = createMockDataSource()
        await registerPlugin({ dataSource })
        // Registration itself runs a CREATE TABLE query; reset call counts so
        // webhook assertions only see queries triggered by the handler.
        dataSource.rpc.executeQuery.mockClear()
    })

    const runWebhook = async (event: unknown) => {
        const { handlers } = await registerPlugin({ dataSource })
        dataSource.rpc.executeQuery.mockClear()
        const handler = handlers['/stripe/webhook'][0]
        return handler(createMockContext(dataSource, JSON.stringify(event)))
    }

    it('should mark the subscription deleted for customer.subscription.deleted events', async () => {
        const response = await runWebhook({
            type: 'customer.subscription.deleted',
            data: { object: { id: 'sub_deleted_1' } },
        })

        expect(response.status).toBe(200)
        const body = await response.json()
        expect(body.result).toEqual({ success: true })
        expect(dataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: expect.stringContaining('WHERE stripe_subscription_id = ?'),
            params: ['sub_deleted_1'],
        })
    })

    it('should upsert subscription data for completed checkout sessions', async () => {
        const response = await runWebhook({
            type: 'checkout.session.completed',
            data: {
                object: {
                    subscription: 'sub_new_1',
                    client_reference_id: 'user-42',
                    customer: 'cus_77',
                },
            },
        })

        expect(response.status).toBe(200)
        expect(dataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: expect.stringContaining('ON CONFLICT(user_id) DO UPDATE'),
            params: ['user-42', 'cus_77', 'sub_new_1'],
        })
    })

    it('should ignore webhook events it does not care about', async () => {
        const response = await runWebhook({
            type: 'invoice.paid',
            data: { object: { id: 'in_1' } },
        })

        expect(response.status).toBe(200)
        expect(dataSource.rpc.executeQuery).not.toHaveBeenCalled()
    })

    it('should skip completed sessions without a subscription id', async () => {
        const response = await runWebhook({
            type: 'checkout.session.completed',
            data: { object: { subscription: null } },
        })

        expect(response.status).toBe(200)
        expect(dataSource.rpc.executeQuery).not.toHaveBeenCalled()
    })

    it('should return a 400 error response for malformed JSON bodies', async () => {
        const { handlers } = await registerPlugin({ dataSource })
        dataSource.rpc.executeQuery.mockClear()
        const handler = handlers['/stripe/webhook'][0]

        const response = await handler(createMockContext(dataSource, '{not-json'))

        expect(response.status).toBe(400)
        const body = await response.json()
        expect(body.error).toContain('Webhook processing failed')
    })
})
