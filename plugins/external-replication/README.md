# External Replication Plugin

Pulls data from a StarbaseDB instance's configured **external** data source (e.g. a
Postgres on Supabase) into the **internal** Durable-Object SQLite database, turning the
instance into a close-to-edge read replica that can be queried locally instead of
round-tripping to the external database.

Implements the pull-based replication described in
[#72](https://github.com/outerbase/starbasedb/issues/72).

## Usage

Register the plugin with the tables you want replicated:

```ts
import { ExternalReplicationPlugin } from './plugins/external-replication'

new ExternalReplicationPlugin({
    tables: [
        // Full snapshot every run:
        { name: 'products' },
        // Incremental — only rows whose `updated_at` advanced since the last run:
        { name: 'orders', cursorColumn: 'updated_at', batchSize: 2000 },
    ],
})
```

- **`cursorColumn`** (optional): a monotonically-increasing column (`updated_at`, `id`, …).
  When set, only new/changed rows are pulled each run and the last value is persisted in
  the `_starbasedb_replication_state` table. Omit it to re-pull the whole table each run.
- **`batchSize`** (optional, default `5000`): rows pulled per run; large tables drain
  across successive runs.

Writes use `INSERT OR REPLACE`, so runs are **idempotent** and safe to retry.

## Triggering

- **Manual:** `POST /replicate` (all configured tables) or `POST /replicate/:table` (one
  table). Admin only.
- **On an interval:** add a
  [Cloudflare Cron Trigger](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
  and invoke the endpoint (or call `replicateAll(...)` directly) from your Worker's
  `scheduled()` handler:

```toml
# wrangler.toml
[triggers]
crons = ["*/5 * * * *"]   # every 5 minutes
```
