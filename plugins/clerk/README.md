# Clerk Plugin

The Clerk Plugin for Starbase provides a quick and simple way for applications to add Clerk user information to their database.

For more information on how to setup webhooks for your Clerk instance, please refer to their excellent [guide](https://clerk.com/docs/webhooks/sync-data).

## Usage

Add the ClerkPlugin plugin to your Starbase configuration:

```typescript
import { ClerkPlugin } from './plugins/clerk'
const plugins = [
    // ... other plugins
    new ClerkPlugin({
        clerkInstanceId: 'ins_**********',
        clerkSigningSecret: 'whsec_**********',
    }),
] satisfies StarbasePlugin[]
```

## Configuration Options

| Option               | Type   | Default | Description                                                                             |
| -------------------- | ------ | ------- | --------------------------------------------------------------------------------------- |
| `clerkInstanceId`    | string | `null`  | Access your instance ID from  (https://dashboard.clerk.com/last-active?path=settings)   |
| `clerkSigningSecret` | string | `null`  | Access your signing secret from (https://dashboard.clerk.com/last-active?path=webhooks) |

## How To Use

### Webhook Setup

For our Starbase instance to receive webhook events when user information changes, we need to add our plugin endpoint to Clerk.

1. Visit the Webhooks page for your Clerk instance: https://dashboard.clerk.com/last-active?path=webhooks
2. Add a new endpoint with the following settings:
    - URL: `https://<your-starbase-instance-url>/clerk/webhook`
    - Events: `User`
3. Save by clicking "Create"
