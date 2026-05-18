import { describe, it, expect, vi, beforeEach } from 'vitest'
import { StripeSubscriptionPlugin } from './index'
import type { StarbaseApp } from '../../src/handler'
import type { DataSource } from '../../src/types'

type RouteHandler = (c: any) => Promise<Response> | Response
type Middleware = (c: any, next: () => Promise<void>) => Promise<void>

function createMockApp() {
    const routes = new Map<string, RouteHandler>()
    const middlewares: Middleware[] = []
    const app = {
        use: vi.fn((middleware: Middleware) => {
            middlewares.push(middleware)
        }),
        post: vi.fn((path: string, handler: RouteHandler) => {
            routes.set(path, handler)
        }),
    } as unknown as StarbaseApp

    return { app, routes, middlewares }
}

async function primePluginContext(
    middleware: Middleware,
    dataSource: DataSource
) {
    const context = {
        get: vi.fn((key: string) =>
            key === 'dataSource' ? dataSource : undefined
        ),
    }

    await middleware(
        context,
        vi.fn(async () => undefined)
    )
}

describe('StripeSubscriptionPlugin', () => {
    let dataSource: DataSource

    beforeEach(() => {
        vi.clearAllMocks()
        dataSource = {
            rpc: {
                executeQuery: vi.fn().mockResolvedValue([]),
            },
        } as unknown as DataSource
    })

    it('requires a Stripe API key when constructed', () => {
        expect(
            () =>
                new StripeSubscriptionPlugin({
                    stripeSecretKey: '',
                    stripeWebhookSecret: 'whsec_test',
                })
        ).toThrow('Stripe API key is required for this plugin.')
    })

    it('registers subscription routes and initializes the table once per request context', async () => {
        const plugin = new StripeSubscriptionPlugin({
            stripeSecretKey: 'sk_test_123',
            stripeWebhookSecret: 'whsec_test',
        })
        const { app, routes, middlewares } = createMockApp()

        await plugin.register(app)
        await primePluginContext(middlewares[0], dataSource)

        expect(routes.has('/stripe/subscribe')).toBe(true)
        expect(routes.has('/stripe/unsubscribe')).toBe(true)
        expect(routes.has('/stripe/webhook')).toBe(true)
        expect(dataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: expect.stringContaining(
                'CREATE TABLE IF NOT EXISTS subscription'
            ),
            params: [],
        })
    })

    it('rejects subscribe requests missing a user or price id before calling Stripe', async () => {
        const plugin = new StripeSubscriptionPlugin({
            stripeSecretKey: 'sk_test_123',
            stripeWebhookSecret: 'whsec_test',
        })
        const { app, routes, middlewares } = createMockApp()

        await plugin.register(app)
        await primePluginContext(middlewares[0], dataSource)

        const response = await routes.get('/stripe/subscribe')?.({
            req: {
                json: vi.fn().mockResolvedValue({ userId: 'user_1' }),
            },
        })

        expect(response?.status).toBe(400)
        await expect(response?.json()).resolves.toMatchObject({
            error: 'Missing required fields: userId, stripePriceId',
        })
    })

    it('marks a subscription deleted when Stripe sends a deletion webhook', async () => {
        const plugin = new StripeSubscriptionPlugin({
            stripeSecretKey: 'sk_test_123',
            stripeWebhookSecret: 'whsec_test',
        })
        const { app, routes, middlewares } = createMockApp()

        await plugin.register(app)
        await primePluginContext(middlewares[0], dataSource)

        const response = await routes.get('/stripe/webhook')?.({
            req: {
                text: vi.fn().mockResolvedValue(
                    JSON.stringify({
                        type: 'customer.subscription.deleted',
                        data: {
                            object: {
                                id: 'sub_deleted',
                            },
                        },
                    })
                ),
            },
        })

        expect(response?.status).toBe(200)
        expect(dataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: expect.stringContaining(
                'WHERE stripe_subscription_id = ? AND deleted_at IS NULL'
            ),
            params: ['sub_deleted'],
        })
    })

    it('upserts subscription data when checkout completion includes a subscription', async () => {
        const plugin = new StripeSubscriptionPlugin({
            stripeSecretKey: 'sk_test_123',
            stripeWebhookSecret: 'whsec_test',
        })
        const { app, routes, middlewares } = createMockApp()

        await plugin.register(app)
        await primePluginContext(middlewares[0], dataSource)

        const response = await routes.get('/stripe/webhook')?.({
            req: {
                text: vi.fn().mockResolvedValue(
                    JSON.stringify({
                        type: 'checkout.session.completed',
                        data: {
                            object: {
                                client_reference_id: 'user_1',
                                customer: 'cus_123',
                                subscription: 'sub_123',
                            },
                        },
                    })
                ),
            },
        })

        expect(response?.status).toBe(200)
        expect(dataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: expect.stringContaining(
                'INSERT INTO subscription (user_id, stripe_customer_id, stripe_subscription_id)'
            ),
            params: ['user_1', 'cus_123', 'sub_123'],
        })
    })

    it('returns a bad request response when webhook JSON cannot be parsed', async () => {
        const consoleError = vi
            .spyOn(console, 'error')
            .mockImplementation(() => undefined)
        const plugin = new StripeSubscriptionPlugin({
            stripeSecretKey: 'sk_test_123',
            stripeWebhookSecret: 'whsec_test',
        })
        const { app, routes, middlewares } = createMockApp()

        await plugin.register(app)
        await primePluginContext(middlewares[0], dataSource)

        const response = await routes.get('/stripe/webhook')?.({
            req: {
                text: vi.fn().mockResolvedValue('not json'),
            },
        })

        expect(response?.status).toBe(400)
        await expect(response?.json()).resolves.toMatchObject({
            error: expect.stringContaining('Webhook processing failed:'),
        })

        consoleError.mockRestore()
    })
})
