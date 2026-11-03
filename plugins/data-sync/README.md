# Data Sync / Replication Plugin

The Data Sync (`DataSyncPlugin` / `ReplicationPlugin`) plugin enables automatic pull-based replication from external data sources (PostgreSQL, MySQL, etc.) into StarbaseDB's internal Durable Object SQLite database so your instance serves as a fast, close-to-edge replica.

## Features

- **Pluggable Database Adapters**: Built-in `PostgresSyncSource` and `MySQLSyncSource` extending `DatabaseSyncSource` (`SyncAdapter`) to isolate dialect-specific schema introspection, column type mapping, and pagination queries.
- **Configurable Sync Interval & Tables**: Define `sync_interval` (in seconds) and specific tables (either by string name or per-table `TableSyncConfig` with custom `trackingColumn`, `primaryKey`, `schema`, and `batchSize`).
- **Incremental Checkpointing**: Automatically tracks the latest value of `trackingColumn` (`updated_at`, `created_at`, primary key, or any custom column) in `tmp_data_sync_metadata` for append/update polling.
- **Schema Resolution & `beforeQuery` Rewriting**:
  - Default `public` schema tables are created at the SQLite root (`public.users` -> `users`), and queries to `public.users` on the internal source are automatically rewritten to `users`.
  - Custom schema tables (`analytics.events`) are mapped to `analytics_events` and transparently rewritten in `beforeQuery`.
- **Internal `tmp_` Table Convention**: Stores sync checkpoints in `tmp_data_sync_metadata` and error logs in `tmp_data_sync_errors`.
- **Admin Endpoints**:
  - `GET /data-sync/status`: Returns per-table sync checkpoints and recent errors.
  - `POST /data-sync/trigger` (or `POST /data-sync/sync`): Manually triggers replication for all tables or a specific `{ "table": "users" }`.

## Usage

```typescript
import {
    DataSyncPlugin,
    PostgresSyncSource,
} from '../plugins/data-sync'

const syncStore = new PostgresSyncSource({
    dialect: 'postgresql',
})

const plugins = [
    new DataSyncPlugin(syncStore, {
        sync_interval: 60,
        tables: [
            'users',
            'person',
            {
                table: 'events',
                schema: 'analytics',
                trackingColumn: 'event_timestamp',
                primaryKey: 'event_id',
                batchSize: 500,
            },
        ],
    }),
] satisfies StarbasePlugin[]
```
