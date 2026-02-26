# Data Sync Plugin

Replicate rows from an external SQL source into the internal Durable Object SQLite database.

## Endpoints

- `GET /data-sync` List configured sync tasks.
- `POST /data-sync` Create or update a task.
- `DELETE /data-sync/:name` Delete a task.
- `POST /data-sync/run/:name` Run a task immediately.

## Create a task

```bash
curl --location 'https://starbasedb.YOUR-ID.workers.dev/data-sync' \
  --header 'Authorization: Bearer ADMIN_TOKEN' \
  --header 'Content-Type: application/json' \
  --data '{
    "name": "users_sync",
    "sourceTable": "users",
    "sourceSchema": "public",
    "targetTable": "users_cache",
    "cursorColumn": "id",
    "intervalCron": "*/5 * * * *",
    "batchSize": 250
  }'
```

## Task fields

- `name` Unique task identifier (letters, numbers, underscores).
- `sourceTable` External table to pull from.
- `sourceSchema` Optional external schema for PostgreSQL/MySQL.
- `targetTable` Internal SQLite table to replicate into.
- `cursorColumn` Incremental checkpoint column (must be monotonic).
- `intervalCron` Cron expression used by the cron plugin.
- `batchSize` Optional pull size (defaults to 250, min 10, max 2000).

## Behavior

- First run pulls earliest rows ordered by `cursorColumn`.
- Later runs pull rows where `cursorColumn > last_cursor_value`.
- Target table is created automatically when missing.
- Missing target columns are added automatically.
- Upserts are conflict-safe using a unique index on `cursorColumn`.

## Requirements

- External SQL datasource must be configured in StarbaseDB.
- Cron plugin must be enabled to run scheduled pulls.
