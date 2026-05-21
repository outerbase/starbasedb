# Replication Plugin

Pulls data from a configured external source (Postgres, MySQL, Turso, etc.) into the internal Durable Object SQLite database on a configurable schedule. This creates a low-latency, close-to-edge read replica without requiring any changes to the external source.

## How it works

1. You register one or more tables to replicate via the HTTP API.
2. The plugin uses the Durable Object alarm system to wake up at the shortest configured interval across all registered tables.
3. On each wake-up it queries the external source for rows newer than the last seen cursor value and upserts them into the internal SQLite.
4. Sync state (last cursor, last sync time, total rows) is persisted between alarm cycles.

The plugin uses append-only, cursor-based polling — it does not support DELETE replication.

## Requirements

An external data source must be configured in `wrangler.toml` (or via environment variables). See the top-level `wrangler.toml` for the full list of `EXTERNAL_DB_*` variables.

## Setup

Register the plugin in your `src/index.ts`:

```ts
import { ReplicationPlugin } from '../plugins/replication'

const replicationPlugin = new ReplicationPlugin()

const plugins = [
    // ...
    replicationPlugin,
] satisfies StarbasePlugin[]
```

All routes require an `Authorization: Bearer <ADMIN_AUTHORIZATION_TOKEN>` header.

## API

### Configure tables to replicate

```
POST /replication/tables
Content-Type: application/json

{
    "tables": [
        {
            "name": "orders",
            "cursorColumn": "id",
            "interval": 30
        },
        {
            "name": "products",
            "cursorColumn": "updated_at",
            "interval": 300
        }
    ]
}
```

- `name` — the table name on the external source (and the name used for the replica in internal SQLite)
- `cursorColumn` — column used to track progress; must be monotonically increasing (e.g. `id`, `updated_at`, `created_at`)
- `interval` — poll interval in seconds (default: 60)

The replica table is created automatically in internal SQLite with TEXT columns on the first sync.

### Get sync status

```
GET /replication/status
```

Returns the configuration and current sync state for every registered table.

```json
{
    "result": [
        {
            "table_name": "orders",
            "cursor_column": "id",
            "interval": 30,
            "last_cursor": "9842",
            "last_sync_at": "2024-11-01 14:23:00",
            "row_count": 9842
        }
    ]
}
```

### Trigger a manual sync

```
POST /replication/sync
```

Immediately syncs all configured tables outside of the normal alarm schedule. Returns a per-table summary.

```json
{
    "result": {
        "success": true,
        "results": [
            { "table": "orders", "inserted": 128 },
            { "table": "products", "inserted": 3 }
        ]
    }
}
```

### Remove a table from replication

```
DELETE /replication/tables/:name
```

Removes the table from the replication schedule and deletes its sync state. The replica data already written to internal SQLite is **not** deleted.

## Internal tables

| Table | Purpose |
|-------|---------|
| `tmp_replication_config` | One row per registered table — stores `cursor_column` and `interval` |
| `tmp_replication_state` | One row per registered table — stores `last_cursor`, `last_sync_at`, and cumulative `row_count` |

## Notes

- Each sync batch is capped at 1 000 rows. If the external table has more new rows than that, the next alarm cycle picks up where the last one left off.
- The alarm is set to fire at the shortest interval across all registered tables. Tables with longer intervals are effectively synced more often than configured, but this has no correctness impact because cursor-based polling is idempotent.
- All replica tables are created with `INSERT OR REPLACE` semantics, so re-syncing a row that already exists in internal SQLite is safe.
- DELETE operations on the external source are not replicated.
