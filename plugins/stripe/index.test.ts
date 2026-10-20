import { describe, it, expect, vi, beforeEach } from 'vitest'
import { StripeSubscriptionPlugin } from './index'

describe('StripeSubscriptionPlugin', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
    })

    it('should throw an error if stripeSecretKey is missing', () => {
        expect(() => {
            new StripeSubscriptionPlugin({
                stripeSecretKey: '',
                stripeWebhookSecret: 'whsec_test',
            })
        }).toThrow('Stripe API key is required for this plugin.')
    })

    it('should initialize with correct name, keys and non-auth setting', () => {
        const plugin = new StripeSubscriptionPlugin({
            stripeSecretKey: 'sk_test_123',
            stripeWebhookSecret: 'whsec_123',
        })

        expect(plugin.name).toBe('starbasedb:stripe-subscriptions')
        expect(plugin.opts.requiresAuth).toBe(false)
        expect(plugin.pathPrefix).toBe('/stripe')
        expect(plugin.stripeSecretKey).toBe('sk_test_123')
        expect(plugin.stripeWebhookSecret).toBe('whsec_123')
    })

    it('should register routes and execute table creation in middleware', async () => {
        const plugin = new StripeSubscriptionPlugin({
            stripeSecretKey: 'sk_test_123',
            stripeWebhookSecret: 'whsec_123',
        })

        const mockApp: any = {
            use: vi.fn(),
            post: vi.fn(),
        }

        await plugin.register(mockApp)

        expect(mockApp.use).toHaveBeenCalledTimes(1)
        expect(mockApp.post).toHaveBeenCalledWith(
            '/stripe/subscribe',
            expect.any(Function)
        )
        expect(mockApp.post).toHaveBeenCalledWith(
            '/stripe/unsubscribe',
            expect.any(Function)
        )
    })

    it('should reject subscribe requests missing required fields', async () => {
        const plugin = new StripeSubscriptionPlugin({
            stripeSecretKey: 'sk_test_123',
            stripeWebhookSecret: 'whsec_123',
        })

        const mockApp: any = {
            use: vi.fn(),
            post: vi.fn(),
        }

        await plugin.register(mockApp)

        const subscribeHandler = mockApp.post.mock.calls.find(
            (call: any[]) => call[0] === '/stripe/subscribe'
        )[1]

        const mockContext: any = {
            req: {
                json: vi.fn().mockResolvedValue({
                    userId: '',
                    stripeProductId: '',
                }),
            },
        }

        const response = await subscribeHandler(mockContext)
        expect(response.status).toBe(400)
    })

    it('should reject unsubscribe requests missing userId', async () => {
        const plugin = new StripeSubscriptionPlugin({
            stripeSecretKey: 'sk_test_123',
            stripeWebhookSecret: 'whsec_123',
        })

        const mockApp: any = {
            use: vi.fn(),
            post: vi.fn(),
        }

        await plugin.register(mockApp)

        const unsubscribeHandler = mockApp.post.mock.calls.find(
            (call: any[]) => call[0] === '/stripe/unsubscribe'
        )[1]

        const mockContext: any = {
            req: {
                json: vi.fn().mockResolvedValue({
                    userId: '',
                }),
            },
        }

        const response = await unsubscribeHandler(mockContext)
        expect(response.status).toBe(400)
    })
})
