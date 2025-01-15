import { StarbaseApp, StarbaseContext } from '../../src/handler'
import { StarbasePlugin } from '../../src/plugin'
import { createResponse } from '../../src/utils'

interface SubscriptionData {
    userId: string
    stripeCustomerId: string
    stripeSubscriptionId: string
}

interface StripeAPIOptions {
    method: string
    path: string
    body?: Record<string, any>
}

const SQL_QUERIES = {
    CREATE_TABLE: `
        CREATE TABLE IF NOT EXISTS subscription (
            user_id TEXT PRIMARY KEY,
            stripe_customer_id TEXT NOT NULL,
            stripe_subscription_id TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            deleted_at DATETIME DEFAULT NULL
        )
    `,
    UPSERT_SUBSCRIPTION: `
        INSERT INTO subscription (user_id, stripe_customer_id, stripe_subscription_id)
        VALUES (?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
        stripe_customer_id = excluded.stripe_customer_id,
        stripe_subscription_id = excluded.stripe_subscription_id,
        updated_at = CURRENT_TIMESTAMP,
        deleted_at = NULL
    `,
    GET_ACTIVE_SUBSCRIPTION: `
        SELECT stripe_subscription_id FROM subscription 
        WHERE user_id = ? AND deleted_at IS NULL
    `,
    MARK_SUBSCRIPTION_DELETED: `
        UPDATE subscription 
        SET deleted_at = CURRENT_TIMESTAMP 
        WHERE user_id = ? AND deleted_at IS NULL
    `,
    MARK_SUBSCRIPTION_DELETED_BY_ID: `
        UPDATE subscription 
        SET deleted_at = CURRENT_TIMESTAMP 
        WHERE stripe_subscription_id = ? AND deleted_at IS NULL
    `,
}

export class StripeSubscriptionPlugin extends StarbasePlugin {
    context?: StarbaseContext
    pathPrefix: string = '/stripe'
    stripeSecretKey: string
    stripeWebhookSecret: string

    constructor(opts?: {
        stripeSecretKey: string
        stripeWebhookSecret: string
    }) {
        super('starbasedb:stripe-subscriptions', {
            // The `requiresAuth` is set to false to allow for the webhooks to be accessible via Stripe
            requiresAuth: false,
        })
        if (!opts?.stripeSecretKey) {
            throw new Error('Stripe API key is required for this plugin.')
        }
        this.stripeSecretKey = opts.stripeSecretKey
        this.stripeWebhookSecret = opts.stripeWebhookSecret
    }

    override async register(app: StarbaseApp) {
        app.use(async (c, next) => {
            this.context = c
            const dataSource = c?.get('dataSource')

            // Create subscription table if it doesn't exist
            await dataSource?.rpc.executeQuery({
                sql: SQL_QUERIES.CREATE_TABLE,
                params: [],
            })

            await next()
        })

        // Route to subscribe a user to a product
        app.post(`${this.pathPrefix}/subscribe`, async (c) => {
            const {
                userId,
                stripeProductId: stripePriceId,
                customerEmail,
            } = await c.req.json()

            if (!userId || !stripePriceId) {
                return createResponse(
                    undefined,
                    'Missing required fields: userId, stripePriceId',
                    400
                )
            }

            try {
                const customer: any = await this.createOrRetrieveCustomer(
                    customerEmail || `${userId}@example.com`,
                    userId
                )

                const subscription: any = await this.createSubscription(
                    customer.id,
                    stripePriceId
                )

                await this.updateSubscriptionData({
                    userId,
                    stripeCustomerId: customer.id,
                    stripeSubscriptionId: subscription.id,
                })

                return createResponse(
                    { success: true, subscriptionId: subscription.id },
                    undefined,
                    200
                )
            } catch (error: any) {
                return createResponse(
                    undefined,
                    `Failed to subscribe: ${error.message}`,
                    500
                )
            }
        })

        // Route to unsubscribe a user from a product
        app.post(`${this.pathPrefix}/unsubscribe`, async (c) => {
            const { userId } = await c.req.json()
            const dataSource = this.context?.get('dataSource')

            if (!userId) {
                return new Response('Missing required fields: userId', {
                    status: 400,
                })
            }

            try {
                // Retrieve subscription data from SQLite
                const result: any = await dataSource?.rpc.executeQuery({
                    sql: SQL_QUERIES.GET_ACTIVE_SUBSCRIPTION,
                    params: [userId],
                })

                if (!result?.length) {
                    return new Response('User not found', { status: 404 })
                }

                const stripeSubscriptionId = result[0].stripe_subscription_id

                // Cancel the subscription
                await this.cancelSubscription(stripeSubscriptionId)

                // Remove from SQLite
                await dataSource?.rpc.executeQuery({
                    sql: SQL_QUERIES.MARK_SUBSCRIPTION_DELETED,
                    params: [userId],
                })

                return createResponse({ success: true }, undefined, 200)
            } catch (error: any) {
                return createResponse(
                    undefined,
                    `Failed to subscribe: ${error.message}`,
                    500
                )
            }
        })

        // Webhook to handle Stripe events
        app.post(`${this.pathPrefix}/webhook`, async (c) => {
            const body = await c.req.text()
            const dataSource = this.context?.get('dataSource')

            try {
                const event = JSON.parse(body)

                if (event.type === 'customer.subscription.deleted') {
                    const subscription = event.data.object

                    await dataSource?.rpc.executeQuery({
                        sql: SQL_QUERIES.MARK_SUBSCRIPTION_DELETED_BY_ID,
                        params: [subscription.id],
                    })
                } else if (event.type === 'checkout.session.completed') {
                    const session = event.data.object

                    if (session.subscription) {
                        // Update subscription data in our database
                        await this.updateSubscriptionData({
                            userId: session.client_reference_id, // User needs to make sure to set this when creating checkout session (as a query param)
                            stripeCustomerId: session.customer,
                            stripeSubscriptionId: session.subscription,
                        })
                    }
                }

                return createResponse({ success: true }, undefined, 200)
            } catch (error: any) {
                console.error('Webhook processing error:', error)
                return createResponse(
                    undefined,
                    `Webhook processing failed: ${error.message}`,
                    400
                )
            }
        })
    }

    private async callStripeAPI<T>({
        method,
        path,
        body,
    }: StripeAPIOptions): Promise<T> {
        const url = `https://api.stripe.com/v1/${path}`
        const headers: HeadersInit = {
            Authorization: `Bearer ${this.stripeSecretKey}`,
            'Content-Type': 'application/x-www-form-urlencoded',
        }

        try {
            const response = await fetch(url, {
                method,
                headers,
                ...(body && { body: new URLSearchParams(body) }),
            })

            if (!response.ok) {
                const errorData = await response.json()
                throw new Error(
                    `Stripe API call failed: ${response.statusText}. Details: ${JSON.stringify(errorData)}`
                )
            }

            return response.json()
        } catch (error: any) {
            console.error('Stripe API error:', error)
            throw error
        }
    }

    private async updateSubscriptionData(data: SubscriptionData) {
        const dataSource = this.context?.get('dataSource')
        await dataSource?.rpc.executeQuery({
            sql: SQL_QUERIES.UPSERT_SUBSCRIPTION,
            params: [
                data.userId,
                data.stripeCustomerId,
                data.stripeSubscriptionId,
            ],
        })
    }

    private async createOrRetrieveCustomer(email: string, userId: string) {
        // First try to find by email as it's more reliable
        const customersByEmail: any = await this.callStripeAPI({
            method: 'GET',
            path: `customers?email=${encodeURIComponent(email)}&limit=1`,
        })

        if (customersByEmail.data?.[0]) {
            const customer = customersByEmail.data[0]

            // Update the existing customer with our metadata
            const updatedCustomer = await this.callStripeAPI({
                method: 'POST',
                path: `customers/${customer.id}`,
                body: {
                    'metadata[user_id]': userId,
                },
            })

            return updatedCustomer
        }

        // If no customer exists, create a new one
        return this.callStripeAPI({
            method: 'POST',
            path: 'customers',
            body: {
                email,
                'metadata[user_id]': userId,
            },
        })
    }

    private async createSubscription(
        customerId: string,
        priceOrProductId: string
    ) {
        // If a product ID is provided, we need to look up its price first
        let priceId = priceOrProductId

        if (priceOrProductId.startsWith('prod_')) {
            // Fetch the first active price for this product
            const prices: any = await this.callStripeAPI({
                method: 'GET',
                path: `prices?product=${priceOrProductId}&active=true&limit=1`,
            })

            if (!prices.data?.[0]?.id) {
                throw new Error('No active price found for this product')
            }

            priceId = prices.data[0].id
        }

        // Get customer's default payment method
        const customer: any = await this.callStripeAPI({
            method: 'GET',
            path: `customers/${customerId}`,
        })

        if (
            !customer.default_payment_method &&
            !customer.invoice_settings?.default_payment_method
        ) {
            throw new Error(
                'Customer has no default payment method. Please add a payment method first.'
            )
        }

        return this.callStripeAPI({
            method: 'POST',
            path: 'subscriptions',
            body: {
                customer: customerId,
                'items[0][price]': priceId,
                default_payment_method:
                    customer.default_payment_method ||
                    customer.invoice_settings.default_payment_method,
            },
        })
    }

    private async cancelSubscription(subscriptionId: string) {
        return this.callStripeAPI({
            method: 'DELETE',
            path: `subscriptions/${subscriptionId}`,
        })
    }
}
