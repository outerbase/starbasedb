## Replication Plugin

Pulls data from the configured external data source (e.g. Postgres on Supabase)
into the internal Durable Object SQLite database, so the StarbaseDB instance
acts as a close-to-edge replica.

### Example Usage

```ts
import { ReplicationPlugin } from '../plugins/replication'

// ....
// ....

const replicationPlugin = new ReplicationPlugin({
    // How often (in milliseconds) an automatic sync cycle should run.
    // Omit to only sync when triggered manually.
    intervalMs: 60_000,
    tables: [
        {
            table: 'users',
            schema: 'public',
            // Append-only polling: only rows with a greater `id` than the
            // last synced watermark are pulled on each cycle.
            watermarkColumn: 'id',
            batchSize: 500,
        },
        {
            table: 'products',
            schema: 'public',
        },
    ],
})

const plugins = [
    // ...
    replicationPlugin,
] satisfies StarbasePlugin[]
```

### Behavior

- A `tmp_replication_state` table is created in the internal database to track
  the last synced watermark (`last_value`) and timestamp (`last_sync_at`) per table.
- On each sync cycle, rows are pulled from the external source with
  `SELECT * FROM "schema"."table" WHERE "watermark" > ? ORDER BY "watermark" ASC LIMIT ?`
  and written locally with `INSERT OR REPLACE`.
- Admin users can trigger a sync manually with `POST /replication/sync` and
  inspect replication state with `GET /replication/status`.
