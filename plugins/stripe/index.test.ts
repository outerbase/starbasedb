import { Hono } from 'hono'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { StripeSubscriptionPlugin } from './index'
import type { DataSource } from '../../src/types'

const createMockDataSource = (results: unknown[] = []) => {
    const executeQuery = vi.fn()

    for (const result of results) {
        executeQuery.mockResolvedValueOnce(result)
    }

    executeQuery.mockResolvedValue([])

    return {
        rpc: {
            executeQuery,
        },
    } as unknown as DataSource
}

const createStripeResponse = (body: unknown, ok = true, statusText = 'OK') =>
    Promise.resolve({
        ok,
        statusText,
        json: () => Promise.resolve(body),
    } as Response)

const getRequestBody = (request: RequestInit | undefined) => {
    const body = request?.body
    expect(body).toBeInstanceOf(URLSearchParams)
    return body as URLSearchParams
}

async function createRegisteredPlugin(opts?: {
    dataSource?: DataSource
    stripeFetch?: ReturnType<typeof vi.fn>
}) {
    const app = new Hono()
    const dataSource = opts?.dataSource ?? createMockDataSource()
    const plugin = new StripeSubscriptionPlugin({
        stripeSecretKey: 'sk_test_123',
        stripeWebhookSecret: 'whsec_test_123',
    })

    app.use('*', async (c: any, next) => {
        c.set('dataSource', dataSource)
        await next()
    })

    if (opts?.stripeFetch) {
        vi.stubGlobal('fetch', opts.stripeFetch)
    }

    await plugin.register(app as any)

    return { app, dataSource, plugin }
}

describe('StripeSubscriptionPlugin', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
    })

    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it('requires a Stripe secret key during construction', () => {
        expect(
            () => new StripeSubscriptionPlugin(undefined as any)
        ).toThrowError('Stripe API key is required for this plugin.')
    })

    it('creates the subscription table when plugin routes run', async () => {
        const dataSource = createMockDataSource()
        const { app } = await createRegisteredPlugin({ dataSource })

        const response = await app.request('/stripe/webhook', {
            method: 'POST',
            body: JSON.stringify({ type: 'ignored.event' }),
        })

        expect(response.status).toBe(200)
        expect(dataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: expect.stringContaining(
                'CREATE TABLE IF NOT EXISTS subscription'
            ),
            params: [],
        })
    })

    it('updates an existing Stripe customer with user metadata', async () => {
        const stripeFetch = vi
            .fn()
            .mockReturnValueOnce(
                createStripeResponse({
                    data: [{ id: 'cus_existing' }],
                })
            )
            .mockReturnValueOnce(
                createStripeResponse({
                    id: 'cus_existing',
                    metadata: { user_id: 'user_123' },
                })
            )

        vi.stubGlobal('fetch', stripeFetch)

        const plugin = new StripeSubscriptionPlugin({
            stripeSecretKey: 'sk_test_123',
            stripeWebhookSecret: 'whsec_test_123',
        })

        const customer = await (plugin as any).createOrRetrieveCustomer(
            'person@example.com',
            'user_123'
        )

        expect(customer.id).toBe('cus_existing')
        expect(stripeFetch).toHaveBeenNthCalledWith(
            1,
            'https://api.stripe.com/v1/customers?email=person%40example.com&limit=1',
            expect.objectContaining({ method: 'GET' })
        )
        const updateRequest = stripeFetch.mock.calls[1][1] as RequestInit
        expect(getRequestBody(updateRequest).get('metadata[user_id]')).toBe(
            'user_123'
        )
    })

    it('creates a Stripe customer when lookup finds none', async () => {
        const stripeFetch = vi
            .fn()
            .mockReturnValueOnce(createStripeResponse({ data: [] }))
            .mockReturnValueOnce(createStripeResponse({ id: 'cus_created' }))

        vi.stubGlobal('fetch', stripeFetch)

        const plugin = new StripeSubscriptionPlugin({
            stripeSecretKey: 'sk_test_123',
            stripeWebhookSecret: 'whsec_test_123',
        })

        const customer = await (plugin as any).createOrRetrieveCustomer(
            'new@example.com',
            'user_456'
        )

        expect(customer.id).toBe('cus_created')
        expect(stripeFetch).toHaveBeenNthCalledWith(
            2,
            'https://api.stripe.com/v1/customers',
            expect.objectContaining({ method: 'POST' })
        )
        const createRequest = stripeFetch.mock.calls[1][1] as RequestInit
        expect(getRequestBody(createRequest).get('email')).toBe(
            'new@example.com'
        )
        expect(getRequestBody(createRequest).get('metadata[user_id]')).toBe(
            'user_456'
        )
    })

    it('resolves product ids to active prices before creating subscriptions', async () => {
        const stripeFetch = vi
            .fn()
            .mockReturnValueOnce(
                createStripeResponse({ data: [{ id: 'price_monthly' }] })
            )
            .mockReturnValueOnce(
                createStripeResponse({
                    id: 'cus_123',
                    default_payment_method: 'pm_card',
                })
            )
            .mockReturnValueOnce(createStripeResponse({ id: 'sub_123' }))

        vi.stubGlobal('fetch', stripeFetch)

        const plugin = new StripeSubscriptionPlugin({
            stripeSecretKey: 'sk_test_123',
            stripeWebhookSecret: 'whsec_test_123',
        })

        const subscription = await (plugin as any).createSubscription(
            'cus_123',
            'prod_123'
        )

        expect(subscription.id).toBe('sub_123')
        expect(stripeFetch).toHaveBeenNthCalledWith(
            1,
            'https://api.stripe.com/v1/prices?product=prod_123&active=true&limit=1',
            expect.objectContaining({ method: 'GET' })
        )
        const subscriptionRequest = stripeFetch.mock.calls[2][1] as RequestInit
        expect(getRequestBody(subscriptionRequest).get('items[0][price]')).toBe(
            'price_monthly'
        )
        expect(
            getRequestBody(subscriptionRequest).get('default_payment_method')
        ).toBe('pm_card')
    })

    it('rejects subscriptions when the customer has no default payment method', async () => {
        const stripeFetch = vi.fn().mockReturnValueOnce(
            createStripeResponse({
                id: 'cus_123',
                invoice_settings: {},
            })
        )

        vi.stubGlobal('fetch', stripeFetch)

        const plugin = new StripeSubscriptionPlugin({
            stripeSecretKey: 'sk_test_123',
            stripeWebhookSecret: 'whsec_test_123',
        })

        await expect(
            (plugin as any).createSubscription('cus_123', 'price_123')
        ).rejects.toThrowError(
            'Customer has no default payment method. Please add a payment method first.'
        )
    })

    it('subscribes a user through the route and persists subscription ids', async () => {
        const dataSource = createMockDataSource()
        const stripeFetch = vi
            .fn()
            .mockReturnValueOnce(createStripeResponse({ data: [] }))
            .mockReturnValueOnce(createStripeResponse({ id: 'cus_new' }))
            .mockReturnValueOnce(
                createStripeResponse({
                    id: 'cus_new',
                    invoice_settings: {
                        default_payment_method: 'pm_default',
                    },
                })
            )
            .mockReturnValueOnce(createStripeResponse({ id: 'sub_new' }))
        const { app } = await createRegisteredPlugin({
            dataSource,
            stripeFetch,
        })

        const response = await app.request('/stripe/subscribe', {
            method: 'POST',
            body: JSON.stringify({
                userId: 'user_789',
                stripeProductId: 'price_789',
            }),
            headers: { 'Content-Type': 'application/json' },
        })

        await expect(response.json()).resolves.toEqual({
            result: { success: true, subscriptionId: 'sub_new' },
        })
        expect(dataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: expect.stringContaining('INSERT INTO subscription'),
            params: ['user_789', 'cus_new', 'sub_new'],
        })
    })

    it('unsubscribes an active user and marks their subscription deleted', async () => {
        const dataSource = createMockDataSource([
            [],
            [{ stripe_subscription_id: 'sub_active' }],
        ])
        const stripeFetch = vi
            .fn()
            .mockReturnValueOnce(createStripeResponse({ id: 'sub_active' }))
        const { app } = await createRegisteredPlugin({
            dataSource,
            stripeFetch,
        })

        const response = await app.request('/stripe/unsubscribe', {
            method: 'POST',
            body: JSON.stringify({ userId: 'user_active' }),
            headers: { 'Content-Type': 'application/json' },
        })

        expect(response.status).toBe(200)
        expect(stripeFetch).toHaveBeenCalledWith(
            'https://api.stripe.com/v1/subscriptions/sub_active',
            expect.objectContaining({ method: 'DELETE' })
        )
        expect(dataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: expect.stringContaining('SET deleted_at = CURRENT_TIMESTAMP'),
            params: ['user_active'],
        })
    })

    it('returns not found when unsubscribe has no active subscription', async () => {
        const dataSource = createMockDataSource([[], []])
        const { app } = await createRegisteredPlugin({ dataSource })

        const response = await app.request('/stripe/unsubscribe', {
            method: 'POST',
            body: JSON.stringify({ userId: 'missing_user' }),
            headers: { 'Content-Type': 'application/json' },
        })

        await expect(response.text()).resolves.toBe('User not found')
        expect(response.status).toBe(404)
    })

    it('handles subscription deletion webhooks', async () => {
        const dataSource = createMockDataSource()
        const { app } = await createRegisteredPlugin({ dataSource })

        const response = await app.request('/stripe/webhook', {
            method: 'POST',
            body: JSON.stringify({
                type: 'customer.subscription.deleted',
                data: { object: { id: 'sub_deleted' } },
            }),
        })

        expect(response.status).toBe(200)
        expect(dataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: expect.stringContaining(
                'WHERE stripe_subscription_id = ? AND deleted_at IS NULL'
            ),
            params: ['sub_deleted'],
        })
    })

    it('handles checkout completion webhooks with subscriptions', async () => {
        const dataSource = createMockDataSource()
        const { app } = await createRegisteredPlugin({ dataSource })

        const response = await app.request('/stripe/webhook', {
            method: 'POST',
            body: JSON.stringify({
                type: 'checkout.session.completed',
                data: {
                    object: {
                        client_reference_id: 'user_checkout',
                        customer: 'cus_checkout',
                        subscription: 'sub_checkout',
                    },
                },
            }),
        })

        expect(response.status).toBe(200)
        expect(dataSource.rpc.executeQuery).toHaveBeenCalledWith({
            sql: expect.stringContaining('INSERT INTO subscription'),
            params: ['user_checkout', 'cus_checkout', 'sub_checkout'],
        })
    })
})
