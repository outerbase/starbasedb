# Data Sync Plugin

The Data Sync Plugin for StarbaseDB replicates tables from an external database source (PostgreSQL, MySQL, Turso, Cloudflare D1, StarbaseDB, Cloudflare Hyperdrive, or Outerbase API) into the internal Durable Object SQLite database, enabling low-latency edge queries against replicated data.

## Features

- **Database Sync Source Abstraction**: Works with `PostgresSyncSource`, `MySQLSyncSource`, `SQLiteSyncSource`, or custom `DatabaseSyncSource` implementations.
- **Automatic Schema Discovery & Table Creation**: Introspects external table columns, normalizes types and defaults to SQLite, and creates internal tables automatically.
- **Smart Schema Mapping**:
    - Default/public schema tables (e.g. `users`, `person`, `public.users`) are created directly in SQLite as `users` and `person`.
    - Custom schema tables (e.g. `analytics.events`) are created as `analytics_events` (or a custom `target_table`).
    - Transparently rewrites `public.<table>` and `<schema>.<table>` references in internal SQLite queries via `beforeQuery`.
- **Flexible Incremental & Full-Table Sync**:
    - Supports incremental sync via `timestamp_column`, `id_column`, or any custom `cursor_column` / `track_column`.
    - Automatically handles tables without `created_at` or `id` columns via full-table pull.
- **Plugin System Metadata Table**: Tracks replication watermarks and errors in `tmp_data_sync_metadata`.

## Usage

### With an Explicit Sync Source

```typescript
import { DataSyncPlugin } from './plugins/data-sync'
import { PostgresSyncSource } from './plugins/postgres-sync'

const syncStore = new PostgresSyncSource({
    dialect: 'postgresql',
})

const plugins = [
    // ... other plugins
    new DataSyncPlugin(syncStore, {
        sync_interval: 60, // Sync every 60 seconds
        tables: [
            'users',
            'person',
            'analytics.events',
            {
                name: 'orders',
                timestamp_column: 'updated_at',
                id_column: 'order_id',
                batch_size: 500,
            },
        ],
    }),
] satisfies StarbasePlugin[]
```

### With Automatic Sync Source Selection

```typescript
import { DataSyncPlugin } from './plugins/data-sync'

const plugins = [
    new DataSyncPlugin({
        sync_interval: 60,
        tables: ['users', 'person'],
    }),
] satisfies StarbasePlugin[]
```

## Configuration Options

### Plugin Options (`DataSyncOptions`)

| Option          | Type                            | Default | Description                                        |
| --------------- | ------------------------------- | ------- | -------------------------------------------------- |
| `sync_interval` | `number`                        | `60`    | Interval in seconds between automatic sync runs    |
| `tables`        | `(string \| TableSyncConfig)[]` | `[]`    | List of table names or detailed table sync configs |
| `auto_sync`     | `boolean`                       | `true`  | Whether to automatically sync tables on interval   |

### Table Configuration (`TableSyncConfig`)

| Option             | Type     | Default        | Description                                                    |
| ------------------ | -------- | -------------- | -------------------------------------------------------------- |
| `name`             | `string` | Required       | Name of the external table to replicate                        |
| `schema`           | `string` | `'public'`     | Optional source schema name                                    |
| `target_table`     | `string` | Auto-generated | Optional custom SQLite table name                              |
| `cursor_column`    | `string` | `undefined`    | Custom monotonic column used to track the latest synced record |
| `timestamp_column` | `string` | `'created_at'` | Timestamp column for incremental replication                   |
| `id_column`        | `string` | `'id'`         | ID column for incremental replication                          |
| `batch_size`       | `number` | `1000`         | Maximum number of rows fetched per sync batch                  |

## Monitoring & Control Endpoints

- `GET /sync-status` (or `GET /sync/status`): Returns current replication configuration and per-table sync watermarks/errors.
- `POST /sync` (or `POST /sync/trigger`): Triggers an immediate sync of all configured tables (or a single table when `{ "table": "users" }` is passed in the JSON body).
- `GET /sync-data` (or `GET /sync/data`): Previews synced rows and metadata across replicated tables.
