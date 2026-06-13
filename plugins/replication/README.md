# Replication Plugin

The StarbaseDB Replication Plugin enables you to replicate tables from an external data source (like PostgreSQL, MySQL, or Turso/SQLite) into the internal Durable Object SQLite database. This allows your StarbaseDB edge instances to serve as a fast close-to-the-edge read replica.

## Features

- **Keyset Pagination**: If an incremental column (like `id` or `created_at`) is configured as the `cursorColumn` for a table, the plugin performs keyset-based pagination (`WHERE cursorColumn > lastCursor`). This is highly efficient ($O(N)$) for large tables compared to standard `LIMIT/OFFSET`.
- **Automatic Scheduling**: If a global or table-level `interval` is set, the plugin automatically creates a cron task inside the Durable Object and schedules alarms, removing any manual setup complexity.
- **Fail-Open Isolation**: Failures in syncing one table do not interrupt or block other tables.
- **Idempotency**: Data is inserted using `INSERT OR REPLACE INTO` statement to ensure that repeating runs are idempotent.
- **Type Mapping**: Safely maps dialect-specific data types (including boolean, numeric, objects/JSON) into SQLite-compatible types.

## Configuration Options

```typescript
export interface ReplicateTableConfig {
    /** Table name in the external source. */
    table: string
    /**
     * Column used for incremental, append-only polling (e.g. `id` or
     * `updated_at`). When set, each run only pulls rows whose value is greater
     * than the highest value already replicated. When omitted, the table is
     * fully re-synced on every run.
     */
    cursorColumn?: string
    /** Columns to pull. Defaults to every column (`*`). */
    columns?: string[]
    /** Optional interval in seconds to sync this specific table. */
    interval?: number
}

export interface ReplicatePluginOptions {
    /**
     * Tables to replicate. When omitted, every base table found in the
     * external source is replicated.
     */
    tables?: ReplicateTableConfig[]
    /** Rows pulled per batch. Bounds memory use. Defaults to 1000. */
    batchSize?: number
    /** Cloudflare ExecutionContext for waitUntil support */
    ctx?: ExecutionContext
    /** Cron interval expression (e.g. '*/5 * * * *') or interval in seconds to automatically run replication. */
    interval?: string | number
}
```

## Example Usage

### 1. Simple Configuration (Manual Trigger)

In `/src/index.ts`:

```ts
import { ReplicationPlugin } from '../plugins/replication'

const plugins = [
    new ReplicationPlugin({
        tables: [
            { table: 'users', cursorColumn: 'id' },
            { table: 'orders', cursorColumn: 'created_at' },
        ],
        batchSize: 500,
        ctx,
    }),
]
```

### 2. Scheduled Configuration (Auto Run)

To automatically run sync every 5 minutes:

```ts
import { ReplicationPlugin } from '../plugins/replication'

const plugins = [
    new ReplicationPlugin({
        tables: [
            { table: 'users', cursorColumn: 'id' },
            { table: 'orders', cursorColumn: 'created_at', interval: 300 }, // Sync orders every 5 minutes
        ],
        interval: '*/5 * * * *', // Trigger overall replication check every 5 minutes
        ctx,
    }),
]
```

## REST API Endpoints

All endpoints are authenticated and require `admin` role authorization.

### 1. POST `/replicate/run`

Forces a manual run of the replication cycle across all configured tables.

**Response (200 OK):**

```json
{
    "result": {
        "results": [
            {
                "table": "users",
                "mode": "incremental",
                "rowsReplicated": 25,
                "status": "synced"
            }
        ]
    }
}
```

### 2. GET `/replicate/status`

Retrieves the current last-sync states, including the last cursor values, sync timestamps, and total rows replicated.

**Response (200 OK):**

```json
{
    "result": {
        "tables": [
            {
                "table_name": "users",
                "cursor_column": "id",
                "last_cursor": "125",
                "last_run_at": "2026-06-13T09:15:30.000Z",
                "rows_replicated": 125
            }
        ]
    }
}
```
