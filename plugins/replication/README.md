# Replication Plugin

Pulls data from your configured **external data source** (e.g. a Postgres database on
Supabase) into the **internal Durable Object SQLite** database. This lets a StarbaseDB
instance act as a close-to-edge replica that can be queried directly instead of always
reaching out to the upstream database.

Replication is **append-only** and **pull-based**: for each table you tell the plugin
which column to track (e.g. `id` or `created_at`), and on every pull it only fetches
rows newer than the highest value it has already seen. The last seen value per table is
stored in a `tmp_replication_checkpoints` table inside the internal database.

## Configuration

```ts
import { ReplicationPlugin } from '../plugins/replication'

const replicationPlugin = new ReplicationPlugin({
    // Which tables to replicate, and the append-only column to track for each.
    tables: [
        { name: 'users', trackBy: 'id', schema: 'public' },
        {
            name: 'orders',
            trackBy: 'created_at',
            schema: 'public',
            destinationTable: 'orders_replica',
        },
    ],
    // How often the plugin auto-pulls when requests arrive (seconds). 0 disables
    // automatic pulling. Defaults to 300 (5 minutes).
    intervalSeconds: 300,
    // Maximum rows fetched per table per pull. Defaults to 1000.
    batchSize: 1000,
})

const plugins = [
    // ...
    replicationPlugin,
] satisfies StarbasePlugin[]
```

| Option             | Required | Default | Description                                                   |
| ------------------ | -------- | ------- | ------------------------------------------------------------- |
| `tables`           | yes      | —       | Tables to replicate. Each needs `name` and `trackBy`.         |
| `trackBy`          | yes      | —       | Monotonically increasing column used for append-only polling. |
| `schema`           | no       | —       | Schema on the external source (e.g. `public`).                |
| `destinationTable` | no       | `name`  | Internal table name to write into.                            |
| `intervalSeconds`  | no       | `300`   | Auto-pull cadence. `0` disables automatic pulls.              |
| `batchSize`        | no       | `1000`  | Max rows fetched per table per pull.                          |

Table, column and schema names are validated as SQL identifiers (letters, numbers and
underscores). Invalid configuration throws a `ReplicationConfigurationError` at startup
so misconfiguration fails loudly instead of at query time.

## How data is pulled

Because Cloudflare Workers cannot run free-standing timers, the `intervalSeconds`
cadence is evaluated lazily on incoming requests: when the interval has elapsed since
the last successful pull, the work is kicked off in the background via `waitUntil` so
query latency is unaffected.

You can also trigger or inspect a pull explicitly:

- **Programmatically:** `await replicationPlugin.pull()` or `await replicationPlugin.getStatus()`
- **Over HTTP (admin only):**
  - `POST /replication/pull` — triggers immediate pull
  - `GET /replication/status` — returns current checkpoints and last pull timestamp
- **On a precise schedule:** wire it to the [Cron plugin](../cron/README.md) and call
  `pull()` from its `onEvent` callback.

```ts
cronPlugin.onEvent(async ({ name }) => {
    if (name === 'replicate') {
        await replicationPlugin.pull()
    }
}, ctx)
```

## Transparent Querying (`beforeQuery` hook)

When querying the internal DO SQLite database, the plugin automatically inspects incoming SQL statements. If a query references a qualified schema from external sources (e.g. `SELECT * FROM public.users`), the plugin transparently rewrites the table reference to the internal destination table (e.g. `users`).

## Notes

- **Automatic Table Provisioning:** If a destination table does not already exist in the internal SQLite database, the plugin auto-creates it dynamically based on the source columns and assigns `PRIMARY KEY` to the tracked column.
- **Idempotency:** Rows are written with `INSERT OR REPLACE`, so re-pulling an already seen row is idempotent rather than causing a duplicate-key error.
- **Strict Typing:** Checkpoints are stored as JSON so the original value type (numeric `id` vs string `created_at`) is preserved when comparing against strongly typed external database engines (such as Postgres).
