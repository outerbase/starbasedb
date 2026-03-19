# Data Sync Plugin

Implements **Issue #72**: incremental pull sync from an external relational database into StarbaseDB’s internal SQLite (Durable Object).

## Features

- **Pull sync** with cursor by monotonic `id` or `updated_at`-style timestamp
- **Batching** + pagination on the upstream query
- **Idempotent writes** via SQLite `INSERT … ON CONFLICT DO UPDATE`
- **Metadata** in `tmp_data_sync_meta`, **logs** in `tmp_data_sync_log`
- **Retries** with exponential backoff on read failures
- **Admin-only HTTP API** for status, manual sync, and debug probe
- **PostgreSQL** (TCP via `pg` / Outerbase SDK) and **Hyperdrive** (`postgres` package); **MySQL** uses the same job format with MySQL-specific paging SQL

## Configuration

Cloudflare Workers do not receive arbitrary TOML tables as `env`. Use **`[vars]`** (and **secrets** for passwords).

Conceptually this matches a `[plugins.data-sync]` block like:

```toml
# Not loaded automatically — document your intent; mirror with [vars] below.
# [plugins.data-sync]
# sync_interval = 300
# tables = ["users", "products"]
```

### `wrangler.toml` example

```toml
[vars]
DATA_SYNC_ENABLED = "true"
DATA_SYNC_INTERVAL_SECONDS = "300"
# JSON array of job objects (escape quotes in TOML or use wrangler secret / dashboard)
DATA_SYNC_JOBS = """[{"externalTable":"public.users","localTable":"users","cursorKind":"incremental_id","cursorColumn":"id","pkColumns":["id"]}]"""
DATA_SYNC_BATCH_SIZE = "250"
DATA_SYNC_MAX_RETRIES = "3"
```

Also set the existing Starbase **external DB** variables (`EXTERNAL_DB_TYPE`, `EXTERNAL_DB_HOST`, etc.) or **Hyperdrive** so `dataSource.external` is populated.

### Job object

| Field           | Description                                                                                    |
| --------------- | ---------------------------------------------------------------------------------------------- |
| `externalTable` | Upstream table, e.g. `public.users`                                                            |
| `localTable`    | SQLite table in the DO (must already exist with compatible columns + PK/UNIQUE on `pkColumns`) |
| `cursorKind`    | `incremental_id` or `timestamp`                                                                |
| `cursorColumn`  | Column for paging (`id`, `updated_at`, …)                                                      |
| `pkColumns`     | Primary key columns for upsert                                                                 |
| `columnMap`     | Optional map `{ "external_col": "sqlite_col" }`                                                |

## HTTP API (Bearer **admin** token)

| Method | Path                     | Description                                                                               |
| ------ | ------------------------ | ----------------------------------------------------------------------------------------- |
| `GET`  | `/data-sync/sync-status` | Metadata rows + recent log                                                                |
| `POST` | `/data-sync/sync-data`   | Run sync. Optional JSON body: `{ "tables": ["users"] }` to filter by **local** table name |
| `GET`  | `/data-sync/debug`       | Redacted external config + `SELECT 1` probe                                               |

## Scheduled sync (CRON)

`DATA_SYNC_INTERVAL_SECONDS` is **informational** only. Schedule sync with:

1. **Cloudflare Workers Cron Triggers** — add a cron in `wrangler.toml` and `fetch` your worker with a route that triggers `POST /data-sync/sync-data` (same host) using the admin token, **or**
2. **`CronPlugin`** — in `src/index.ts`, register a task that performs an HTTP callback to `/data-sync/sync-data`, **or**
3. External scheduler (GitHub Actions, etc.) calling the same endpoint.

## Local demo

See `example/README.md` and `example/docker-compose.yml`.

## Edge notes

- Keep **batch sizes** modest (default 250, max 1000) to respect CPU/time limits.
- **Hyperdrive** is recommended for Postgres from Workers in production.
- Ensure the SQLite side has a **UNIQUE** or **PRIMARY KEY** constraint matching `pkColumns` so `ON CONFLICT` works.
