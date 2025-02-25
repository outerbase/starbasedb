# Clerk Plugin

The Clerk Plugin for Starbase provides a quick and simple way for applications to add Clerk user information to their database.

For more information on how to setup webhooks for your Clerk instance, please refer to their excellent [guide](https://clerk.com/docs/webhooks/sync-data).

## Usage

Add the ClerkPlugin plugin to your Starbase configuration:

```typescript
import { ClerkPlugin } from './plugins/clerk'
const clerkPlugin = new ClerkPlugin({
    clerkInstanceId: 'ins_**********',
    clerkSigningSecret: 'whsec_**********',
    clerkSessionPublicKey: '-----BEGIN PUBLIC KEY***'
})
const plugins = [
    clerkPlugin,
    // ... other plugins
] satisfies StarbasePlugin[]
```

If you want to use the Clerk plugin to verify sessions, change the function `authenticate` in `src/index.ts` to the following:

```diff
... existing code ...
} else {
+    try {
+        const authenticated = await clerkPlugin.authenticate(request, dataSource)
+        if (!authenticated) {
+            throw new Error('Unauthorized request')
+        }
+    } catch (error) {
        // If no JWT secret or JWKS endpoint is provided, then the request has no authorization.
        throw new Error('Unauthorized request')
    }
}
... existing code ...
```

## Configuration Options

| Option                  | Type     | Default | Description                                                                                      |
| ----------------------- | -------- | ------- | ------------------------------------------------------------------------------------------------ |
| `clerkSigningSecret`    | string   | `null`  | Access your signing secret from (https://dashboard.clerk.com/last-active?path=webhooks)          |
| `clerkInstanceId`       | string   | `null`  | (optional) Access your instance ID from  (https://dashboard.clerk.com/last-active?path=settings) |
| `verifySessions`        | boolean  | `true`  | (optional) Verify sessions                                                                       |
| `clerkSessionPublicKey` | string   | `null`  | (optional) Access your public key from (https://dashboard.clerk.com/last-active?path=api-keys)   |
| `permittedOrigins`      | string[] | `[]`    | (optional) A list of allowed origins                                                             |

## How To Use

### Webhook Setup

For our Starbase instance to receive webhook events when user information changes, we need to add our plugin endpoint to Clerk.

1. Visit the Webhooks page for your Clerk instance: https://dashboard.clerk.com/last-active?path=webhooks
2. Add a new endpoint with the following settings:
    - URL: `https://<your-starbase-instance-url>/clerk/webhook`
    - Events:
      - `User`,
      - `Session` if you also want to verify sessions ("session.pending" does not appear to be sent by Clerk, so you can keep it deselected)
3. Save by clicking "Create" and copy the signing secret into the Clerk plugin
4. If you want to verify sessions, you will need to add a public key to your Clerk instance:
    - Visit the API Keys page for your Clerk instance: https://dashboard.clerk.com/last-active?path=api-keys
    - Click the copy icon next to `JWKS Public Key`
5. Copy the public key into the Clerk plugin
