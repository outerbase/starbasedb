# StarbaseDB Replication Plugin

Replicates tables and rows from an external database source (PostgreSQL, MySQL, Turso, Cloudflare D1, or StarbaseDB) into the internal StarbaseDB Durable Object SQLite database.

## Features

- **On-Demand & Periodic Sync:** Trigger replication via `POST /replication/sync` or automatically on `beforeQuery` when `autoSyncOnQuery` is enabled and `intervalSeconds` has elapsed.
- **Status Monitoring:** Inspect sync metadata (`table_name`, `rows_synced`, `last_synced_at`, `status`) via `GET /replication/status` backed by `_starbase_replication_meta`.
- **Automatic Table Discovery & Schema Inference:** Automatically discovers external tables when `tables` is omitted and creates matching SQLite tables locally.
- **Batched Transactions & Conflict Strategies:** Supports `replace` (`INSERT OR REPLACE`) and `ignore` (`INSERT OR IGNORE`) conflict strategies with configurable `batchSize`.
- **SQL Identifier Validation:** Strictly validates table and column names before constructing DDL/DML queries.

## Usage

```ts
import { ReplicationPlugin } from '@outerbase/starbasedb/plugins'

const replication = new ReplicationPlugin({
    tables: ['users', 'orders'],
    intervalSeconds: 60,
    autoSyncOnQuery: true,
    conflictStrategy: 'replace',
    batchSize: 100,
})
```
