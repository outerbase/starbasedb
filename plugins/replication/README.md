# Replication Plugin

Pull new and changed rows from an **external source** (Postgres, MySQL — e.g. a
Supabase database) into StarbaseDB's **internal SQLite** on a schedule. Each table
is replicated with append-only polling: the plugin remembers the last value of a
user-chosen tracking column and only fetches rows beyond it on the next run, giving
you a queryable edge replica without hitting the source on every read.

## How it works

A Durable Object has a single alarm, which StarbaseDB hardcodes to the [Cron
plugin](../cron). Rather than competing for that alarm, the replication plugin
registers a **cron task per job** and runs its sync when that task fires — so
scheduling is delegated to cron and there is no alarm collision.

On each tick, for every active job, the plugin:

1. Queries the external source for rows newer than the stored cursor:
   `SELECT <columns> FROM <table> WHERE <tracking_col> > ? ORDER BY <tracking_col> ASC LIMIT <batch_size>`
   (the predicate is omitted on the very first run).
2. Ensures the destination table exists, inferring column types from the data.
3. Upserts the page with `INSERT OR REPLACE` into the internal database.
4. Advances the cursor to the largest tracking value seen and persists it.
5. Repeats until a page comes back shorter than `batch_size` (or a per-run page
   cap is hit, in which case the remainder is picked up on the next tick).

The external pull bypasses the internal RLS, allowlist and cache layers and uses
`?` placeholders (the Outerbase SDK rewrites these to `$1`/`?` per dialect), so the
query reaches the source unmodified.

## Configuration

Every endpoint requires the **admin** authorization token — jobs hold external
database credentials and write to the internal database.

A job is described by:

| Field           | Required | Description                                                                                                     |
| --------------- | -------- | --------------------------------------------------------------------------------------------------------------- |
| `name`          | yes      | Unique job id (`[A-Za-z0-9_-]`).                                                                                |
| `source`        | yes      | External connection: `{ dialect, host, port, user, password, database }`. `dialect` is `postgresql` or `mysql`. |
| `table_name`    | yes      | Table to replicate from the source.                                                                             |
| `tracking_col`  | yes      | Column used to detect new rows (e.g. `updated_at` or `id`).                                                     |
| `tracking_type` | no       | `timestamp` (default) or `id` — controls cursor comparison.                                                     |
| `cron_tab`      | yes      | Standard cron expression for the pull interval (e.g. `*/5 * * * *`).                                            |
| `target_table`  | no       | Internal table name (defaults to `table_name`).                                                                 |
| `columns`       | no       | Subset of columns to replicate (defaults to all).                                                               |
| `primary_key`   | no       | Column(s) used as the destination primary key for idempotent upserts.                                           |
| `batch_size`    | no       | Rows per page, 1–10000 (default 500).                                                                           |

> When `columns` is set it must include `tracking_col` and every `primary_key`
> column — otherwise the cursor could never advance and the destination table
> would reference a column that is never pulled. This is validated on create.

## API

```bash
# Create / update a job (and schedule it)
curl -X POST http://localhost:8787/replication/jobs \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "users_sync",
    "table_name": "users",
    "tracking_col": "updated_at",
    "tracking_type": "timestamp",
    "cron_tab": "*/5 * * * *",
    "primary_key": ["id"],
    "source": {
      "dialect": "postgresql",
      "host": "db.xxx.supabase.co",
      "port": 5432,
      "user": "postgres",
      "password": "•••",
      "database": "postgres"
    }
  }'

# List jobs and their status (passwords are redacted)
curl http://localhost:8787/replication/jobs -H "Authorization: Bearer $ADMIN_TOKEN"

# Run a job immediately
curl -X POST http://localhost:8787/replication/jobs/users_sync/run -H "Authorization: Bearer $ADMIN_TOKEN"

# Reset a job's cursor (re-replicate from the beginning)
curl -X POST http://localhost:8787/replication/jobs/users_sync/reset -H "Authorization: Bearer $ADMIN_TOKEN"

# Pause / resume a job
curl -X PATCH http://localhost:8787/replication/jobs/users_sync \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"is_active": false}'

# Delete a job (and its cron task)
curl -X DELETE http://localhost:8787/replication/jobs/users_sync -H "Authorization: Bearer $ADMIN_TOKEN"
```

## Setup

The plugin is registered in `src/index.ts` after the cron plugin, sharing the cron
instance for scheduling:

```ts
import { CronPlugin } from '../plugins/cron'
import { ReplicationPlugin } from '../plugins/replication'

const cronPlugin = new CronPlugin()
const replicationPlugin = new ReplicationPlugin({ cron: cronPlugin })

// Sync runs when a replication cron task fires. dataSource is captured from the
// request scope because the cron callback runs on a separate request.
cronPlugin.onEvent(
    (event) => replicationPlugin.handleCronEvent(event, dataSource),
    ctx
)

const plugins = [
    // ...
    cronPlugin,
    replicationPlugin,
] satisfies StarbasePlugin[]
```

## Notes & limitations

- **Tracking column** should be monotonically increasing and ideally unique. The
  cursor predicate uses `>` (strictly greater) to avoid re-writing the boundary
  row; if many rows share a tracking value across a page boundary one could be
  skipped, so prefer a unique `id` or a high-resolution timestamp.
- **Cron granularity** is one minute, inherited from standard cron expressions.
- **Append-only / upsert.** Source deletes are not propagated (this is a pull-based
  replica); supply a `primary_key` so re-synced rows replace rather than duplicate.
- **Observability.** Each job row records `last_run_at`, `last_error` and
  `rows_synced`; a failing job is isolated and never blocks the others.
- Operational state lives in `tmp_replication_jobs`.
