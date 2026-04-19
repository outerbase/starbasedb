# Replication Plugin

Pull-based data replication from external databases (Postgres, MySQL, etc.) into StarbaseDB's internal SQLite Durable Object.

## Features

- **Pull-based replication**: Periodically fetch data from external sources
- **Incremental sync**: Track progress using a configurable tracking column (e.g., `id`, `created_at`)
- **Table filtering**: Choose which tables and columns to replicate
- **Configurable intervals**: Set custom sync intervals (default: 1 minute)
- **Conflict strategies**: Handle duplicate rows with `replace`, `ignore`, or `update`
- **State tracking**: Monitor sync progress per table with built-in state and logging
- **REST API**: Manage and monitor replication via HTTP endpoints

## Configuration

```typescript
import { ReplicationPlugin } from './plugins/replication'

const replicationPlugin = new ReplicationPlugin({
    intervalMs: 60000, // Sync every 60 seconds
    batchSize: 1000,    // Max rows per sync per table
    conflictStrategy: 'replace', // How to handle duplicates
    tables: [
        {
            sourceTable: 'users',
            targetTable: 'users', // Optional, defaults to sourceTable
            trackingColumn: 'id', // Column for incremental sync
            // columns: ['id', 'name', 'email'], // Optional: specific columns
            // filter: 'active = true', // Optional: WHERE clause filter
        },
        {
            sourceTable: 'orders',
            trackingColumn: 'created_at',
            filter: "status = 'completed'",
        },
    ],
})
```

## API Endpoints

All endpoints require admin authentication.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/replication/status` | Get sync status for all tables |
| GET | `/replication/logs?limit=50` | Get recent sync logs |
| GET | `/replication/tables` | List configured tables |
| POST | `/replication/sync` | Trigger manual sync |

## How It Works

1. **Configuration**: Define which tables to replicate and how (tracking column, filters, etc.)
2. **Initialization**: Creates `tmp_replication_state` and `tmp_replication_log` tables
3. **Scheduled Sync**: Uses Cloudflare Durable Object Alarms for periodic sync
4. **Incremental**: Only fetches new/updated rows based on the tracking column
5. **State Persistence**: Tracks `last_synced_value` per table for resume capability

## Integration Example

```typescript
// In your index.ts
import { ReplicationPlugin } from '../plugins/replication'

const replicationPlugin = new ReplicationPlugin({
    intervalMs: 30000, // Every 30 seconds
    tables: [
        {
            sourceTable: 'external_users',
            targetTable: 'users',
            trackingColumn: 'updated_at',
            columns: ['id', 'name', 'email', 'updated_at'],
        },
    ],
})

// Add to plugins array
const plugins = [
    // ... other plugins
    replicationPlugin,
]
```

## Requirements

- External database must be configured in `wrangler.toml` (PostgreSQL, MySQL, etc.)
- Admin authentication enabled
- Cloudflare Durable Objects enabled

## Notes

- The plugin uses Durable Object Alarms for scheduling (no external cron service needed)
- For large tables, use `batchSize` to limit memory usage
- The tracking column should be indexed in the external source for optimal performance
- First sync will fetch all existing rows (up to batchSize)
