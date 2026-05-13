# ReplicationPlugin

The `ReplicationPlugin` pulls data from an external PostgreSQL source into StarbaseDB's internal Durable Object SQLite database on demand. Each sync cycle fetches only rows newer than the last checkpoint (cursor-based incremental sync), upserts them into the local SQLite replica, and updates a checkpoint record. The SQLite replica can then be queried at the edge with no round-trip to the origin database.

## Enabling the Plugin

Add `ReplicationPlugin` to the `plugins` array when constructing `StarbaseDB`:

```typescript
import { StarbaseDB } from '@outerbase/starbasedb'
import { ReplicationPlugin } from '@outerbase/starbasedb/plugins'

const replication = new ReplicationPlugin({
    tables: ['users', 'orders'],
    cursorColumn: 'id',
    batchSize: 500,
    ctx,
})

const db = new StarbaseDB({ dataSource, config, plugins: [replication] })
```

## Configuration Options

| Option         | Type               | Default | Description                                                                         |
| -------------- | ------------------ | ------- | ----------------------------------------------------------------------------------- |
| `tables`       | `string[]`         | `[]`    | Tables to replicate. An empty array replicates **all** public tables automatically. |
| `cursorColumn` | `string`           | `'id'`  | Column used as the incremental cursor (must be monotonically increasing).           |
| `batchSize`    | `number`           | `500`   | Maximum rows fetched per table per sync cycle.                                      |
| `ctx`          | `ExecutionContext` | —       | Cloudflare Worker execution context. Required for non-blocking `waitUntil` support. |

## Required `wrangler.toml` Variables

The plugin reads from whatever external PostgreSQL source is configured for StarbaseDB:

```toml
[vars]
EXTERNAL_DB_TYPE     = "postgresql"
EXTERNAL_DB_HOST     = "your-postgres-host"
EXTERNAL_DB_PORT     = 5432
EXTERNAL_DB_USER     = "your-user"
EXTERNAL_DB_PASS     = "your-password"
EXTERNAL_DB_DATABASE = "your-database"
EXTERNAL_DB_DEFAULT_SCHEMA = "public"   # optional, defaults to "public"
```

## How Incremental Sync Works

Each table gets its own checkpoint row stored in `tmp_replication_checkpoints`.

1. **First sync** — no checkpoint exists, so the full table is fetched in batches of `batchSize`, ordered by `cursorColumn` ascending.
2. **Subsequent syncs** — only rows where `cursorColumn > last_cursor_value` are fetched. After each batch, the checkpoint is updated with the highest cursor value seen and the cumulative row count.
3. Rows are written to SQLite using `INSERT OR REPLACE`, so re-syncing the same rows is always safe (idempotent).

### Triggering a Sync

**Manually** via the HTTP API (admin-only):

```bash
curl -X POST https://your-worker/replication/run \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
```

**On a schedule** — use the [CronPlugin](../cron) to call `POST /replication/run` on an interval, or wire it to a Cloudflare Cron Trigger in your worker's `scheduled` handler:

```typescript
export default {
    async scheduled(_event, _env, ctx) {
        ctx.waitUntil(replication.sync()) // or POST /replication/run
    },
}
```

### Checking Status

```bash
curl https://your-worker/replication/status \
  -H "Authorization: Bearer <ADMIN_TOKEN>"
```

Returns all checkpoint rows plus the current plugin configuration.

## Limitations

- **PostgreSQL only** — MySQL, D1, Turso, and Starbase sources are not yet supported. Sync will log a warning and exit early for non-Postgres sources.
- **No DELETE replication** — rows deleted from the source are not removed from the SQLite replica. Full-table refresh (dropping and re-creating the replica) is a planned future feature.
- **Append/update only** — the cursor assumes rows are either inserted or updated with an ever-increasing cursor value. Backfilled or out-of-order rows may not be captured.
- **Schema must pre-exist in SQLite** — the plugin does not create destination tables automatically. You must create matching tables in SQLite before the first sync.
- **Single-column cursor** — composite cursors are not supported.
