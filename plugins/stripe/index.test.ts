import { beforeEach, describe, expect, it, vi } from 'vitest'
import { StripeSubscriptionPlugin } from './index'
import type { DataSource } from '../../src/types'

const jsonResponse = (body: unknown, status = 200, statusText = 'OK') =>
    new Response(JSON.stringify(body), {
        status,
        statusText,
        headers: { 'Content-Type': 'application/json' },
    })

let plugin: StripeSubscriptionPlugin

beforeEach(() => {
    vi.restoreAllMocks()
    plugin = new StripeSubscriptionPlugin({
        stripeSecretKey: 'sk_test_123',
        stripeWebhookSecret: 'whsec_123',
    })
})

describe('StripeSubscriptionPlugin - Initialization', () => {
    it('requires a Stripe secret key', () => {
        expect(
            () =>
                new StripeSubscriptionPlugin({
                    stripeSecretKey: '',
                    stripeWebhookSecret: 'whsec_123',
                })
        ).toThrow('Stripe API key is required for this plugin.')
    })

    it('initializes as an unauthenticated webhook-capable plugin', () => {
        expect(plugin.name).toBe('starbasedb:stripe-subscriptions')
        expect(plugin.opts.requiresAuth).toBe(false)
        expect(plugin.pathPrefix).toBe('/stripe')
        expect(plugin.stripeSecretKey).toBe('sk_test_123')
        expect(plugin.stripeWebhookSecret).toBe('whsec_123')
    })
})

describe('StripeSubscriptionPlugin - Stripe API helpers', () => {
    it('sends form-encoded Stripe API requests with bearer auth', async () => {
        const fetchMock = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValue(jsonResponse({ id: 'cus_123' }))

        const result = await plugin['callStripeAPI']({
            method: 'POST',
            path: 'customers',
            body: {
                email: 'alice@example.com',
                'metadata[user_id]': 'user_123',
            },
        })

        expect(result).toEqual({ id: 'cus_123' })
        expect(fetchMock).toHaveBeenCalledWith(
            'https://api.stripe.com/v1/customers',
            {
                method: 'POST',
                headers: {
                    Authorization: 'Bearer sk_test_123',
                    'Content-Type': 'application/x-www-form-urlencoded',
                },
                body: expect.any(URLSearchParams),
            }
        )

        const body = fetchMock.mock.calls[0][1]?.body as URLSearchParams
        expect(body.get('email')).toBe('alice@example.com')
        expect(body.get('metadata[user_id]')).toBe('user_123')
    })

    it('includes Stripe error details when the API returns a non-ok response', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            jsonResponse(
                { error: { message: 'card declined' } },
                402,
                'Payment Required'
            )
        )
        vi.spyOn(console, 'error').mockImplementation(() => {})

        await expect(
            plugin['callStripeAPI']({
                method: 'GET',
                path: 'customers/cus_missing',
            })
        ).rejects.toThrow(
            'Stripe API call failed: Payment Required. Details: {"error":{"message":"card declined"}}'
        )
    })

    it('updates metadata when an existing customer is found by email', async () => {
        const apiSpy = vi
            .spyOn(plugin as any, 'callStripeAPI')
            .mockResolvedValueOnce({ data: [{ id: 'cus_existing' }] })
            .mockResolvedValueOnce({ id: 'cus_existing', updated: true })

        const customer = await plugin['createOrRetrieveCustomer'](
            'alice@example.com',
            'user_123'
        )

        expect(customer).toEqual({ id: 'cus_existing', updated: true })
        expect(apiSpy).toHaveBeenNthCalledWith(1, {
            method: 'GET',
            path: 'customers?email=alice%40example.com&limit=1',
        })
        expect(apiSpy).toHaveBeenNthCalledWith(2, {
            method: 'POST',
            path: 'customers/cus_existing',
            body: { 'metadata[user_id]': 'user_123' },
        })
    })

    it('creates a customer when no existing customer matches the email', async () => {
        const apiSpy = vi
            .spyOn(plugin as any, 'callStripeAPI')
            .mockResolvedValueOnce({ data: [] })
            .mockResolvedValueOnce({ id: 'cus_new' })

        const customer = await plugin['createOrRetrieveCustomer'](
            'new@example.com',
            'user_456'
        )

        expect(customer).toEqual({ id: 'cus_new' })
        expect(apiSpy).toHaveBeenNthCalledWith(2, {
            method: 'POST',
            path: 'customers',
            body: {
                email: 'new@example.com',
                'metadata[user_id]': 'user_456',
            },
        })
    })

    it('resolves product ids to active prices before creating a subscription', async () => {
        const apiSpy = vi
            .spyOn(plugin as any, 'callStripeAPI')
            .mockResolvedValueOnce({ data: [{ id: 'price_123' }] })
            .mockResolvedValueOnce({
                id: 'cus_123',
                default_payment_method: 'pm_default',
            })
            .mockResolvedValueOnce({ id: 'sub_123' })

        const subscription = await plugin['createSubscription'](
            'cus_123',
            'prod_123'
        )

        expect(subscription).toEqual({ id: 'sub_123' })
        expect(apiSpy).toHaveBeenNthCalledWith(1, {
            method: 'GET',
            path: 'prices?product=prod_123&active=true&limit=1',
        })
        expect(apiSpy).toHaveBeenNthCalledWith(3, {
            method: 'POST',
            path: 'subscriptions',
            body: {
                customer: 'cus_123',
                'items[0][price]': 'price_123',
                default_payment_method: 'pm_default',
            },
        })
    })

    it('uses invoice settings as the fallback default payment method', async () => {
        const apiSpy = vi
            .spyOn(plugin as any, 'callStripeAPI')
            .mockResolvedValueOnce({
                id: 'cus_123',
                invoice_settings: { default_payment_method: 'pm_invoice' },
            })
            .mockResolvedValueOnce({ id: 'sub_123' })

        await plugin['createSubscription']('cus_123', 'price_123')

        expect(apiSpy).toHaveBeenNthCalledWith(2, {
            method: 'POST',
            path: 'subscriptions',
            body: {
                customer: 'cus_123',
                'items[0][price]': 'price_123',
                default_payment_method: 'pm_invoice',
            },
        })
    })

    it('rejects subscriptions when a customer has no default payment method', async () => {
        vi.spyOn(plugin as any, 'callStripeAPI').mockResolvedValueOnce({
            id: 'cus_123',
            invoice_settings: {},
        })

        await expect(
            plugin['createSubscription']('cus_123', 'price_123')
        ).rejects.toThrow(
            'Customer has no default payment method. Please add a payment method first.'
        )
    })

    it('deletes the Stripe subscription when cancelling', async () => {
        const apiSpy = vi
            .spyOn(plugin as any, 'callStripeAPI')
            .mockResolvedValue({ id: 'sub_123', deleted: true })

        const result = await plugin['cancelSubscription']('sub_123')

        expect(result).toEqual({ id: 'sub_123', deleted: true })
        expect(apiSpy).toHaveBeenCalledWith({
            method: 'DELETE',
            path: 'subscriptions/sub_123',
        })
    })
})

describe('StripeSubscriptionPlugin - Subscription persistence', () => {
    it('upserts subscription data through the registered data source context', async () => {
        const executeQuery = vi.fn().mockResolvedValue([])
        const dataSource = {
            rpc: { executeQuery },
        } as unknown as DataSource

        plugin.context = {
            get: vi.fn(() => dataSource),
        } as any

        await plugin['updateSubscriptionData']({
            userId: 'user_123',
            stripeCustomerId: 'cus_123',
            stripeSubscriptionId: 'sub_123',
        })

        expect(executeQuery).toHaveBeenCalledWith({
            sql: expect.stringContaining('INSERT INTO subscription'),
            params: ['user_123', 'cus_123', 'sub_123'],
        })
    })
})
