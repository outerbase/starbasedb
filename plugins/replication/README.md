# Replication Plugin (`starbasedb:replication`)

Pulls data from an external StarbaseDB data source (PostgreSQL, MySQL, Cloudflare D1, Turso, Starbase, Hyperdrive, or Outerbase API) into the internal Durable Object SQLite database so StarbaseDB acts as a low-latency edge replica.

## Features

- **Selective table replication**: Replicate specific tables with optional target table names and `WHERE` filters.
- **Full & incremental cursor sync**: Configure a monotonic cursor column (e.g. `updated_at` or `id`) to pull only new/updated rows and persist checkpoints in `_starbase_replication_state`.
- **Automatic table provisioning & schema evolution**: Infers SQLite schemas from external rows (or schema metadata) and automatically issues `ALTER TABLE ... ADD COLUMN ...` when new columns appear on the source.
- **Batching & retries**: Processes rows in configurable batches with exponential backoff retry handling and error tracking.
- **Scheduled sync & REST API**: Schedule periodic refreshes via Durable Object alarms (`intervalMs` / `cronTab`) and manage replication via HTTP routes under `/replication`.

## Example Usage

```ts
import { ReplicationPlugin } from '../plugins/replication'

const replication = new ReplicationPlugin({
    tables: [
        {
            tableName: 'users',
            primaryKey: 'id',
            cursorColumn: 'updated_at',
            batchSize: 500,
        },
        {
            tableName: 'orders',
            targetTable: 'orders_replica',
            primaryKey: 'id',
            cursorColumn: 'id',
        },
    ],
    syncIntervalMs: 60_000,
    maxRetries: 3,
})
```

## HTTP Endpoints

- `GET /replication/status` — Returns replication state and cursors from `_starbase_replication_state`.
- `POST /replication/sync` — Triggers replication immediately (`{ "table"?: string, "fullRefresh"?: boolean }`).
- `POST /replication/tables` — Adds or updates a replicated table configuration.
- `DELETE /replication/tables/:table` — Unregisters a table from replication.
- `POST /replication/callback` — Internal/cron callback endpoint that runs scheduled replication cycles and reschedules the next alarm.
