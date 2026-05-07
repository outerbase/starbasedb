# Replication Plugin

Propagates write queries (`INSERT`, `UPDATE`, `DELETE`) from a primary StarbaseDB instance to one or more peer instances in the background.

## How it works

The plugin hooks into the `afterQuery` lifecycle. When a write is detected, the original SQL is forwarded to each configured replica via `fetch`, wrapped in `ctx.waitUntil` so replication never adds latency to the primary response.

Unlike the CDC plugin, which captures change events for observability and downstream consumers, this plugin focuses on **cross-instance write propagation** — keeping peer StarbaseDB instances in sync with the primary.

Replication is implemented via query interception rather than polling, consistent with StarbaseDB's plugin architecture and Cloudflare Worker runtime constraints.

```
Client → StarbaseDB (primary)
              │
              ├─ executes query, returns result immediately
              │
              └─ afterQuery → waitUntil (non-blocking)
                    ├─ replica 1: POST /query
                    └─ replica 2: POST /query
```

## Configuration

| Option      | Type       | Required | Description                                                    |
|-------------|------------|----------|----------------------------------------------------------------|
| `replicas`  | `string[]` | ✅        | URLs of peer StarbaseDB instances to receive replicated writes |
| `authToken` | `string`   | ✅        | Bearer token for replica instances (see Security below)        |
| `tables`    | `string[]` | ❌        | Allowlist of table names to replicate. Omit to replicate all.  |

### Security: `authToken`

Each replication request is sent as:

```
Authorization: Bearer <authToken>
```

This must match the `ADMIN_AUTHORIZATION_TOKEN` configured on each replica instance. Without it, replicas will reject incoming writes. Keep this value out of source control — use `wrangler secret` or environment variables.

## Usage

In `src/index.ts`, register the plugin and inject the `ExecutionContext`:

```ts
import { ReplicationPlugin } from '../plugins/replication'

const replicationPlugin = new ReplicationPlugin({
    replicas: ['https://my-replica.example.workers.dev'],
    authToken: 'your-replica-admin-token',
    // Optional: only replicate writes to specific tables
    // tables: ['users', 'orders'],
})

// Inject ExecutionContext so the plugin can schedule background work
replicationPlugin.onEvent(ctx)

const plugins = [
    // ...other plugins
    replicationPlugin,
] satisfies StarbasePlugin[]
```

## Guarantees

| Property | Behaviour |
|---|---|
| **Non-blocking** | Replication runs via `ctx.waitUntil` — zero impact on primary response time |
| **Safe failure** | A replica being unreachable is logged; the primary query result is unaffected |
| **Parallel fanout** | `Promise.allSettled` — one failing replica never blocks others |
| **Fail-open parsing** | If SQL cannot be parsed, the query is skipped (not replicated), never crashes |
| **Precise filtering** | If table filtering is configured and the target table cannot be determined, the query is skipped rather than forwarded blindly |

## Notes

- Replicas must be running StarbaseDB instances with a valid `ADMIN_AUTHORIZATION_TOKEN`
- Schema must exist on replicas before replication begins — this plugin replicates DML, not DDL
- Only `INSERT`, `UPDATE`, `DELETE`, and `REPLACE` are forwarded; `SELECT` is ignored
- Ensure replica URLs do not point back to the primary instance to avoid replication loops
