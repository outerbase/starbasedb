import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { StarbaseApp, StarbaseContext } from '../../src/handler'
import type { DataSource } from '../../src/types'
import { StripeSubscriptionPlugin } from './index'

const fetchMock = vi.fn()

const createJsonResponse = (body: unknown, ok = true, statusText = 'OK') =>
    ({
        ok,
        statusText,
        json: vi.fn().mockResolvedValue(body),
    }) as unknown as Response

const createDataSource = () =>
    ({
        rpc: {
            executeQuery: vi.fn().mockResolvedValue([]),
        },
    }) as unknown as DataSource

const createContext = (dataSource: DataSource) =>
    ({
        get: vi.fn((key: string) =>
            key === 'dataSource' ? dataSource : undefined
        ),
        req: {
            json: vi.fn(),
            text: vi.fn(),
        },
    }) as unknown as StarbaseContext

describe('StripeSubscriptionPlugin', () => {
    let dataSource: DataSource
    let context: StarbaseContext
    let plugin: StripeSubscriptionPlugin

    beforeEach(() => {
        vi.clearAllMocks()
        vi.stubGlobal('fetch', fetchMock)
        vi.spyOn(console, 'error').mockImplementation(() => {})

        dataSource = createDataSource()
        context = createContext(dataSource)
        plugin = new StripeSubscriptionPlugin({
            stripeSecretKey: 'sk_test_123',
            stripeWebhookSecret: 'whsec_123',
        })
    })

    it('requires a Stripe API key and exposes authless plugin metadata', () => {
        expect(
            () =>
                new StripeSubscriptionPlugin({
                    stripeSecretKey: '',
                    stripeWebhookSecret: 'whsec_123',
                })
        ).toThrow('Stripe API key is required for this plugin.')

        expect(plugin.name).toBe('starbasedb:stripe-subscriptions')
        expect(plugin.opts.requiresAuth).toBe(false)
        expect(plugin.pathPrefix).toBe('/stripe')
    })

    it('calls Stripe with form-encoded bodies and bearer auth', async () => {
        fetchMock.mockResolvedValueOnce(createJsonResponse({ id: 'cus_123' }))

        const result = await (plugin as any).callStripeAPI({
            method: 'POST',
            path: 'customers',
            body: {
                email: 'alice@example.com',
                'metadata[user_id]': 'user_1',
            },
        })

        expect(result).toEqual({ id: 'cus_123' })
        expect(fetchMock).toHaveBeenCalledWith(
            'https://api.stripe.com/v1/customers',
            expect.objectContaining({
                method: 'POST',
                headers: {
                    Authorization: 'Bearer sk_test_123',
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: expect.any(URLSearchParams),
            })
        )

        const body = fetchMock.mock.calls[0][1].body as URLSearchParams
        expect(body.get('email')).toBe('alice@example.com')
        expect(body.get('metadata[user_id]')).toBe('user_1')
    })

    it('propagates Stripe API errors with response details', async () => {
        fetchMock.mockResolvedValueOnce(
            createJsonResponse(
                { error: { message: 'bad request' } },
                false,
                'Bad Request'
            )
        )

        await expect(
            (plugin as any).callStripeAPI({
                method: 'GET',
                path: 'customers/cus_missing',
            })
        ).rejects.toThrow(
            'Stripe API call failed: Bad Request. Details: {"error":{"message":"bad request"}}'
        )
    })

    it('updates existing Stripe customers with Starbase user metadata', async () => {
        fetchMock
            .mockResolvedValueOnce(
                createJsonResponse({ data: [{ id: 'cus_existing' }] })
            )
            .mockResolvedValueOnce(
                createJsonResponse({
                    id: 'cus_existing',
                    metadata: { user_id: 'user_1' },
                })
            )

        const customer = await (plugin as any).createOrRetrieveCustomer(
            'alice@example.com',
            'user_1'
        )

        expect(customer.id).toBe('cus_existing')
        expect(fetchMock).toHaveBeenNthCalledWith(
            1,
            'https://api.stripe.com/v1/customers?email=alice%40example.com&limit=1',
            expect.objectContaining({ method: 'GET' })
        )
        expect(fetchMock).toHaveBeenNthCalledWith(
            2,
            'https://api.stripe.com/v1/customers/cus_existing',
            expect.objectContaining({ method: 'POST' })
        )
    })

    it('creates a new Stripe customer when no customer matches by email', async () => {
        fetchMock
            .mockResolvedValueOnce(createJsonResponse({ data: [] }))
            .mockResolvedValueOnce(createJsonResponse({ id: 'cus_new' }))

        const customer = await (plugin as any).createOrRetrieveCustomer(
            'bob@example.com',
            'user_2'
        )

        expect(customer).toEqual({ id: 'cus_new' })
        expect(fetchMock).toHaveBeenNthCalledWith(
            2,
            'https://api.stripe.com/v1/customers',
            expect.objectContaining({ method: 'POST' })
        )
    })

    it('creates subscriptions from product ids after resolving an active price', async () => {
        fetchMock
            .mockResolvedValueOnce(
                createJsonResponse({ data: [{ id: 'price_active' }] })
            )
            .mockResolvedValueOnce(
                createJsonResponse({
                    id: 'cus_123',
                    invoice_settings: {
                        default_payment_method: 'pm_invoice_default',
                    },
                })
            )
            .mockResolvedValueOnce(createJsonResponse({ id: 'sub_123' }))

        const subscription = await (plugin as any).createSubscription(
            'cus_123',
            'prod_123'
        )

        expect(subscription).toEqual({ id: 'sub_123' })
        expect(fetchMock).toHaveBeenNthCalledWith(
            1,
            'https://api.stripe.com/v1/prices?product=prod_123&active=true&limit=1',
            expect.objectContaining({ method: 'GET' })
        )

        const subscriptionBody = fetchMock.mock.calls[2][1]
            .body as URLSearchParams
        expect(subscriptionBody.get('customer')).toBe('cus_123')
        expect(subscriptionBody.get('items[0][price]')).toBe('price_active')
        expect(subscriptionBody.get('default_payment_method')).toBe(
            'pm_invoice_default'
        )
    })

    it('rejects subscription creation when the customer has no default payment method', async () => {
        fetchMock.mockResolvedValueOnce(
            createJsonResponse({
                id: 'cus_123',
                invoice_settings: {},
            })
        )

        await expect(
            (plugin as any).createSubscription('cus_123', 'price_123')
        ).rejects.toThrow(
            'Customer has no default payment method. Please add a payment method first.'
        )
    })

    it('registers routes and initializes subscription storage middleware', async () => {
        const routes: Record<string, Function> = {}
        const app = {
            use: vi.fn(async (middleware) => middleware(context, vi.fn())),
            post: vi.fn((path, handler) => {
                routes[path] = handler
            }),
        } as unknown as StarbaseApp

        await plugin.register(app)

        expect(dataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: expect.stringContaining(
                'CREATE TABLE IF NOT EXISTS subscription'
            ),
            params: [],
        })
        expect(Object.keys(routes).sort()).toEqual([
            '/stripe/subscribe',
            '/stripe/unsubscribe',
            '/stripe/webhook',
        ])
    })

    it('subscribes a user and persists the returned Stripe subscription id', async () => {
        const routes: Record<string, Function> = {}
        const app = {
            use: vi.fn(async (middleware) => middleware(context, vi.fn())),
            post: vi.fn((path, handler) => {
                routes[path] = handler
            }),
        } as unknown as StarbaseApp
        await plugin.register(app)
        vi.mocked(context.req.json).mockResolvedValue({
            userId: 'user_1',
            stripeProductId: 'price_123',
            customerEmail: 'alice@example.com',
        })
        vi.spyOn(plugin as any, 'createOrRetrieveCustomer').mockResolvedValue({
            id: 'cus_123',
        })
        vi.spyOn(plugin as any, 'createSubscription').mockResolvedValue({
            id: 'sub_123',
        })

        const response = await routes['/stripe/subscribe'](context)

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            result: { success: true, subscriptionId: 'sub_123' },
        })
        expect(dataSource.rpc.executeQuery).toHaveBeenLastCalledWith({
            sql: expect.stringContaining('INSERT INTO subscription'),
            params: ['user_1', 'cus_123', 'sub_123'],
        })
    })

    it('unsubscribes an active user subscription and marks it deleted locally', async () => {
        const routes: Record<string, Function> = {}
        vi.mocked(dataSource.rpc.executeQuery)
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([
                { stripe_subscription_id: 'sub_123' },
            ] as any)
            .mockResolvedValueOnce([])
        const app = {
            use: vi.fn(async (middleware) => middleware(context, vi.fn())),
            post: vi.fn((path, handler) => {
                routes[path] = handler
            }),
        } as unknown as StarbaseApp
        await plugin.register(app)
        vi.mocked(context.req.json).mockResolvedValue({ userId: 'user_1' })
        vi.spyOn(plugin as any, 'cancelSubscription').mockResolvedValue({
            id: 'sub_123',
        })

        const response = await routes['/stripe/unsubscribe'](context)

        expect(response.status).toBe(200)
        expect((plugin as any).cancelSubscription).toHaveBeenCalledWith(
            'sub_123'
        )
        expect(dataSource.rpc.executeQuery).toHaveBeenLastCalledWith({
            sql: expect.stringContaining('UPDATE subscription'),
            params: ['user_1'],
        })
    })

    it('handles Stripe webhook subscription deletion events', async () => {
        const routes: Record<string, Function> = {}
        const app = {
            use: vi.fn(async (middleware) => middleware(context, vi.fn())),
            post: vi.fn((path, handler) => {
                routes[path] = handler
            }),
        } as unknown as StarbaseApp
        await plugin.register(app)
        vi.mocked(context.req.text).mockResolvedValue(
            JSON.stringify({
                type: 'customer.subscription.deleted',
                data: { object: { id: 'sub_deleted' } },
            })
        )

        const response = await routes['/stripe/webhook'](context)

        expect(response.status).toBe(200)
        expect(dataSource.rpc.executeQuery).toHaveBeenLastCalledWith({
            sql: expect.stringContaining('WHERE stripe_subscription_id = ?'),
            params: ['sub_deleted'],
        })
    })
})
