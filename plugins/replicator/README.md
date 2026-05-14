# Replicator Plugin

Pulls data from a configured **external data source** (e.g. a Postgres database
on Supabase) into the **internal Durable Object SQLite** so a StarbaseDB
instance can serve as a close-to-edge replica that can be queried instead of
hitting the upstream database directly.

Replication is a **pull** mechanism and is **append-only**: for each table you
register a monotonically increasing _tracking column_ (e.g. `id` or
`created_at`). On every sync the plugin pulls only the rows whose tracking
column is greater than the last value it has already seen, and upserts them
into the matching internal table with `INSERT OR REPLACE`.

## Requirements

An external data source must be configured (see the `EXTERNAL_DB_*` /
`HYPERDRIVE` settings in `wrangler.toml`). Without one the management endpoints
still work but `POST /replicator/sync` will report an error per table.

## Endpoints

All endpoints require an **admin** authorization token.

### `GET /replicator/tables`

Lists every table configured for replication, including the last synced
watermark (`last_value`) and `last_synced_at`.

### `POST /replicator/tables`

Registers (or updates) a table for replication.

```json
{
    "table": "orders",
    "schema": "public",
    "trackingColumn": "id",
    "intervalSeconds": 300,
    "batchSize": 1000,
    "isActive": true
}
```

- `table` (required) – name of the table in both the external and internal DB.
- `trackingColumn` (required) – append-only column used as the watermark.
- `schema` – optional schema name for the external table.
- `intervalSeconds` – how often the table should be polled (default `300`).
- `batchSize` – max rows pulled per sync (default `1000`).
- `isActive` – set to `false` to pause replication for the table.

### `DELETE /replicator/tables/:table`

Removes a table from replication. Existing internal data is left untouched.

### `POST /replicator/sync`

Triggers a sync immediately. Pass `?table=<name>` to sync a single table,
otherwise every active table is synced. Returns the number of rows replicated
per table. This endpoint can be driven by a Cloudflare Cron Trigger, the cron
plugin, or any external scheduler.

## Automatic polling

By default the plugin also syncs opportunistically: on incoming requests it
checks whether any table's `intervalSeconds` has elapsed since its last sync
and, if so, replicates it in the background (via `ctx.waitUntil`). Pass
`new ReplicatorPlugin({ autoSyncOnRequest: false })` in `src/index.ts` to rely
solely on the `/replicator/sync` endpoint instead.
