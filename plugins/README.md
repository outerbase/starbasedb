# Data Replicator Plugin

This plugin provides a robust mechanism to replicate data from an external data source (e.g., a PostgreSQL database on Supabase) into the internal StarbaseDB SQLite database.

## Features

- **Pull-Based Replication**: Periodically pulls data from an external source.
- **Incremental Sync**: Only fetches new records by tracking the last synced value of a specified key (e.g., `id` or `created_at`).
- **Configurable**: Replication jobs (source, table, sync key) are designed to be configured via `wrangler.toml`.
- **Efficient**: Uses D1's `batch` operation for efficient bulk inserts.

## Setup

1.  Add the external database connection string to your `wrangler.toml` file under the `[vars]` section:
    ```toml
    [vars]
    EXTERNAL_DB_URL = "postgresql://user:***@host:port/database"
    ```
2.  Add a cron trigger to your `wrangler.toml` to define the schedule for this plugin:
    ```toml
    [[crons]]
    cron = "*/15 * * * *" # Every 15 minutes
    type = "scheduled"
    ```
3.  Ensure the target table (e.g., `users`) exists in the internal D1 database.
