# StarbaseDB Replication Plugin (`starbasedb:replication`)

A pull-based replication plugin for **StarbaseDB** that continuously or on-demand replicates data from external databases (PostgreSQL/Supabase, MySQL, etc.) into the internal Durable Object SQLite instance, serving as an ultra-fast, close-to-the-edge read replica.

---

## Features

- **Edge Replica Architecture:** Pull data from your central database (e.g. Supabase Postgres) directly into Cloudflare Durable Object SQLite to provide sub-millisecond read access at the edge.
- **Incremental Cursor Sync:** Support for cursor-based incremental sync (`cursorColumn` like `id`, `updated_at`, or sequential timestamps), querying only newly modified or added rows (`WHERE cursorColumn > previousCursor`).
- **Idempotent Upserts:** Employs `INSERT OR REPLACE INTO` keyed by `primaryKey` to ensure idempotent replication and prevent duplicate records.
- **Schema-Aware Auto-Creation:** Automatically provisions target tables in SQLite on first sync with type inference (`INTEGER`, `REAL`, `TEXT`) and primary key assignment. Handles schema-qualified table names (e.g. `public.users` -> `users`).
- **Resilient State Persistence:** Tracks sync status, last cursor, total synced rows, and error diagnostics in `_starbase_replication_state`.
- **Concurrency Guard:** Locks in-flight sync jobs per table to prevent race conditions from concurrent triggers.
- **Full REST API:** Endpoints under `/replication/*` to check health, trigger manual syncs, add dynamic configurations, or reset cursors.
- **Cron / Alarm Ready:** Exposes `syncAll()` and `handleCron()` for scheduled synchronization in Cloudflare Workers.

---

## Configuration

### Table Replication Config (`TableReplicationConfig`)

| Property              | Type       | Default                     | Description                                                                    |
| :-------------------- | :--------- | :-------------------------- | :----------------------------------------------------------------------------- |
| `name`                | `string`   | _(Required)_                | Source table name (e.g. `"public.users"` or `"orders"`).                       |
| `targetTable`         | `string`   | `name` (stripped of schema) | Destination table in local SQLite.                                             |
| `cursorColumn`        | `string`   | `undefined`                 | Column to track for incremental sync (`id`, `updated_at`, etc.).               |
| `primaryKey`          | `string`   | `"id"`                      | Local table primary key used for upserting.                                    |
| `batchSize`           | `number`   | `500`                       | Max rows pulled per sync batch (clamped 1 - 5000).                             |
| `syncIntervalSeconds` | `number`   | `60`                        | Background sync interval.                                                      |
| `whereClause`         | `string`   | `undefined`                 | Optional SQL predicate applied to external query (e.g. `"status = 'active'"`). |
| `columns`             | `string[]` | `["*"]`                     | Specific columns to replicate.                                                 |

---

## Installation & Setup

Import and register `ReplicationPlugin` in your `src/index.ts`:

```typescript
import { ReplicationPlugin } from '../plugins/replication'
import type { StarbasePlugin } from './plugin'

const replicationPlugin = new ReplicationPlugin({
    tables: [
        {
            name: 'public.users',
            targetTable: 'users',
            cursorColumn: 'id',
            primaryKey: 'id',
            batchSize: 1000,
        },
        {
            name: 'public.orders',
            cursorColumn: 'updated_at',
            primaryKey: 'id',
            whereClause: "created_at >= '2024-01-01'",
        },
    ],
    defaultIntervalSeconds: 60,
    autoCreateTable: true,
})

const plugins = [
    // ...other plugins
    replicationPlugin,
] satisfies StarbasePlugin[]
```

---

## REST API Endpoints

### 1. `GET /replication/status`

Returns the status of all replicated tables, number of configured tables, and any currently active sync operations.

**Response (200 OK):**

```json
{
    "result": {
        "tables": [
            {
                "table_name": "public.users",
                "cursor_value": "15420",
                "last_sync_at": 1716300000000,
                "total_rows_synced": 15420,
                "status": "synced",
                "last_error": null
            }
        ],
        "configuredCount": 2,
        "syncingTables": []
    },
    "error": null
}
```

### 2. `POST /replication/sync`

Triggers an immediate replication cycle.

**Body (optional):**

```json
{
    "table": "public.users",
    "forceFull": false
}
```

- If `table` is omitted, all configured tables are synchronized sequentially.
- If `forceFull: true`, ignores existing cursor and performs a full pull from the start.

**Response (200 OK):**

```json
{
    "result": {
        "table": "public.users",
        "rowsSynced": 250,
        "newCursor": "15670",
        "durationMs": 42
    },
    "error": null
}
```

### 3. `POST /replication/configure`

Dynamically register or update a table configuration at runtime.

**Body:**

```json
{
    "name": "public.products",
    "cursorColumn": "id",
    "batchSize": 200
}
```

### 4. `POST /replication/reset`

Resets replication state and cursor, allowing the next sync to re-pull from the start.

**Body (optional):**

```json
{
    "table": "public.users"
}
```

_(Omit `table` to reset state across all tables)._

---

## Scheduled Background Sync (Cron / Durable Object Alarms)

To sync automatically on a schedule, call `handleCron()` from your Worker `scheduled` event:

```typescript
export default {
    async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
        ctx.waitUntil(replicationPlugin.handleCron())
    },
}
```

---

## State Table Schema

The plugin maintains its state in an internal SQLite table:

```sql
CREATE TABLE IF NOT EXISTS _starbase_replication_state (
    table_name TEXT PRIMARY KEY,
    cursor_value TEXT,
    last_sync_at INTEGER,
    total_rows_synced INTEGER DEFAULT 0,
    status TEXT DEFAULT 'idle', -- 'idle' | 'syncing' | 'synced' | 'error'
    last_error TEXT
);
```

---

## Notes & Limitations

- **Updates & Deletes:** When `cursorColumn` is set to `updated_at` or a timestamp, updated source rows are pulled and upserted via `INSERT OR REPLACE INTO`. For hard deletes in source databases without soft-delete flags, trigger a full sync with `{ forceFull: true }` or use CDC webhooks.
- **Identifier Safety:** Table and column names are escaped to support schema qualification and SQL reserved keywords safely.
