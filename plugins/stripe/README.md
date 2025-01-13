# Stripe Subscriptions Plugin

The Stripe Subscriptions Plugin for Starbase provides a quick and simple way for applications to begin accepting product subscription payments.

## Usage

Add the StripeSubscriptionPlugin plugin to your Starbase configuration:

```typescript
import { StripeSubscriptionPlugin } from './plugins/stripe'
const plugins = [
    // ... other plugins
    new StripeSubscriptionPlugin({
        stripeSecretKey: 'sk_test_**********',
        stripeWebhookSecret: 'whsec_**********',
    }),
] satisfies StarbasePlugin[]
```

## Configuration Options

| Option                | Type   | Default | Description                                                             |
| --------------------- | ------ | ------- | ----------------------------------------------------------------------- |
| `stripeSecretKey`     | string | `null`  | Access your secret key from (https://dashboard.stripe.com/apikeys)      |
| `stripeWebhookSecret` | string | `null`  | Access your signing secret from (https://dashboard.stripe.com/webhooks) |

## How To Use

### Webhook Setup

For our Starbase instance to receive webhook events when subscription events change, we need to add our plugin endpoint to Stripe.

1. Visit the Developer Webhooks page: https://dashboard.stripe.com/webhooks
2. Click "+ Add Endpoint"
3. Set "Endpoint URL" to `https://starbasedb.YOUR-IDENTIFIER.dev/stripe/webhook`
4. Add two events to listen to:
    - `customer.subscription.deleted`
    - `checkout.session.completed`
5. Save by clicking "Add Endpoint"

### Product Subscription Setup

After you create a subscription product inside of Stripe you can get the hosted link by following these steps:

1. Click on the "Product catalog" section
2. Click on the product you want
3. Click the "..." menu next to the Pricing item you want a link for
4. Click "Create new payment link"

Now you will have a new payment URL for you to direct your users to in order for them to checkout a new subscription of your product. We will take that URL and insert it
into our frontend application similar to the example below.

_IMPORTANT:_ You must append the `client_reference_id={userId}` at the end so we can attribute the correct user for the purchase.

```html
<body>
    <a
        href="https://buy.stripe.com/INSERT-SUBSCRIPTION-ID?client_reference_id=INSERT-USER-ID"
        class="subscribe-button"
    >
        Subscribe
    </a>
</body>
```

Assuming all of the correct values were set in your installation phases, when a customer successfully subscribes via the Stripe Payment Link you should see a new entry automatically populate inside your SQLite table named `subscription`. At any point if this subscription is cancelled, even from the Stripe interface, the webhook will be handled via this plugin and automatically mark the `deleted_at` column with the date time it became inactive.
