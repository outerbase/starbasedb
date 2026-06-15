# Replication Plugin

Pulls data from an **external** data source (e.g. a Postgres instance on
Supabase) into the **internal** Durable Object SQLite database so a StarbaseDB
instance can serve as a close-to-edge replica that can be queried instead of
querying the upstream source directly.

The plugin uses a **pull** mechanism (rather than per-provider push), which is a
better global solution as discussed in
[#72](https://github.com/outerbase/starbasedb/issues/72).

## How it works

For each configured table the plugin:

1. Reads a bounded, ordered batch of rows from the external source using the
   existing `executeQuery` operation pointed at the external connection.
2. Auto-creates the target table in the internal SQLite store (based on the
   columns returned) if it does not already exist.
3. Upserts the rows into the internal table keyed on a primary key column, so
   re-running replication is idempotent.
4. Persists a checkpoint (the last seen value of the configured `cursorColumn`)
   in the internal `tmp_replication_checkpoints` table. On subsequent runs only
   rows with a cursor value greater than the checkpoint are fetched, enabling
   append-only incremental polling. Because the checkpoint lives in SQLite it
   survives Durable Object hibernation.

Each table is replicated independently — a failure replicating one table does
not abort the others (fail-open), and the error is recorded in the checkpoint
row for that table.

## Configuration

```ts
import { CronPlugin } from '../plugins/cron'
import { ReplicationPlugin } from '../plugins/replication'

const cronPlugin = new CronPlugin()

const replicationPlugin = new ReplicationPlugin({
    cron: cronPlugin, // optional — enables scheduled runs
    config: {
        // Optional cron expression; requires a CronPlugin instance + a matching
        // entry in tmp_cron_tasks whose `name` is "starbasedb:replication".
        schedule: '*/5 * * * *',
        defaultBatchSize: 1000,
        tables: [
            {
                sourceTable: 'users', // table on the external source
                targetTable: 'users', // internal table (defaults to sourceTable)
                cursorColumn: 'id', // append-only polling column (e.g. id / created_at)
                primaryKeyColumn: 'id', // upsert key (defaults to cursorColumn)
                batchSize: 1000, // rows pulled per run (defaults to defaultBatchSize)
            },
        ],
    },
})
```

Add `replicationPlugin` to the `plugins` array passed to `StarbaseDB`.

## Admin endpoints

Both endpoints require an admin role.

- `POST /replication/run` — trigger a replication run for all configured tables.
  Pass `?table=<targetTable>` to replicate a single table. Returns the rows
  replicated and the advanced cursor value per table.
- `GET /replication/status` — return the current checkpoints (last value, total
  rows replicated, last run timestamp, last error) for every replicated table.
