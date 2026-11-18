# StarbaseDB Replica Plugin

The **ReplicaPlugin** pulls configurable tables from an external data source (defined via `wrangler.toml` / `dataSource.external` or Hyperdrive) into the internal Durable Object SQLite database, providing a near-edge read replica.

## Features

- **Paginated Pull Synchronization**: Fetches external tables in configurable page sizes (`batchSize`, default `100`) using `LIMIT` and `OFFSET`.
- **Automatic Schema Provisioning**: Inspects external table schemas (`information_schema.columns` for PostgreSQL/MySQL, `PRAGMA table_info` for SQLite) or infers column types from fetched rows, and creates matching tables in Durable Object SQLite via `CREATE TABLE IF NOT EXISTS`.
- **Idempotent Upserts**: Replicates rows using `INSERT OR REPLACE INTO ...` so repeated syncs safely update existing records.
- **Sync Metadata Tracking**: Stores per-table sync timestamps, row counts, status, and error details in `tmp_replica_status`.
- **Admin-Protected Endpoints**:
  - `POST /replica/sync` — Triggers replication for configured tables or an optional per-request `tables` / `batchSize` override.
  - `GET /replica/status` — Returns configured tables and the latest `tmp_replica_status` rows.

## Configuration

### In `src/index.ts`

```ts
import { ReplicaPlugin } from '../plugins/replica'

const replicaPlugin = new ReplicaPlugin({
    tables: [
        'users',
        {
            table: 'orders',
            schema: 'public',
            primaryKey: 'id',
            batchSize: 250,
            where: "status = 'paid'",
        },
    ],
    batchSize: 100,
})
```

### In `wrangler.toml`

Configure your external database source (e.g. `EXTERNAL_DB_TYPE`, `EXTERNAL_DB_HOST`, `OUTERBASE_API_KEY`, etc.) and optionally set:

```toml
[vars]
REPLICA_TABLES = "users,orders"
REPLICA_BATCH_SIZE = 100
```

## API Reference

### `POST /replica/sync`

Requires `Authorization: Bearer <ADMIN_AUTHORIZATION_TOKEN>`.

Optional JSON body:

```json
{
    "tables": ["users", { "table": "orders", "primaryKey": "order_id", "batchSize": 50 }],
    "batchSize": 100
}
```

Example response (`200 OK`):

```json
{
    "result": {
        "syncedAt": "2026-11-15T15:55:00.000Z",
        "results": [
            {
                "table": "users",
                "schema": "public",
                "rowsSynced": 150,
                "pages": 2,
                "status": "success"
            }
        ],
        "totalRowsSynced": 150
    }
}
```

### `GET /replica/status`

Requires `Authorization: Bearer <ADMIN_AUTHORIZATION_TOKEN>`.

Returns the configured table list and all recorded rows from `tmp_replica_status`.
