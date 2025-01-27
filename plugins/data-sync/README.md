# Data Sync Plugin

The Data Sync plugin enables automatic data synchronization between external data sources and StarbaseDB's internal SQLite database. This plugin creates close-to-edge replicas by automatically pulling and synchronizing data from external sources at configurable intervals.

## Features

- Automatic data synchronization from external sources
- Configurable sync intervals per table
- Selective table synchronization
- Incremental updates using timestamp and/or ID columns
- Schema-aware table synchronization
- Comprehensive type mapping
- Error handling and retry logic
- Sync state tracking and monitoring

## Installation

```toml
# wrangler.toml
[plugins.data-sync]
sync_interval = 300 # 5 minutes
tables = [
    "users",                    # Simple table (public schema)
    "public.products",          # Explicit public schema
    "users.profile",           # Custom schema
    {
        name: "orders",         # Config object with default schema
        timestamp_column: "created_at"
    },
    {
        name: "audit.logs",     # Config object with schema in name
        timestamp_column: "logged_at",
        batch_size: 500
    }
]
```

## Configuration

### Basic Configuration

- `sync_interval`: Time between sync operations in seconds (default: 300)
- `tables`: Array of tables to sync (can be string or object)

### Table Configuration Options

- `name`: Table name (can include schema, e.g., "schema.table")
- `schema`: Database schema (optional, defaults to "public")
- `timestamp_column`: Column for timestamp-based syncing (default: "created_at")
- `id_column`: Column for ID-based syncing (default: "id")
- `batch_size`: Number of records to sync per batch (default: 1000)

### Environment Variables

```env
EXTERNAL_DB_TYPE=postgresql
EXTERNAL_DB_HOST=localhost
EXTERNAL_DB_PORT=5432
EXTERNAL_DB_USER=postgres
EXTERNAL_DB_PASS=postgres
EXTERNAL_DB_DATABASE=demo
EXTERNAL_DB_DEFAULT_SCHEMA=public
```

## Usage

### Basic Usage

```typescript
import { DataSyncPlugin } from '@starbasedb/data-sync'
import { PostgresSyncSource } from '@starbasedb/postgres-sync'

// Create a sync source for your database
const postgresSync = new PostgresSyncSource({
    dialect: 'postgresql',
    schema: 'public',
})

// Create the plugin
const dataSyncPlugin = new DataSyncPlugin(postgresSync, {
    sync_interval: 300,
    tables: ['users', 'products'],
})

// Register with your app
app.register(dataSyncPlugin)
```

### Advanced Usage

```typescript
const dataSyncPlugin = new DataSyncPlugin(postgresSync, {
    sync_interval: 300,
    tables: [
        // Simple table with defaults
        'users',

        // Custom sync configuration
        {
            name: 'orders',
            timestamp_column: 'order_date',
            id_column: 'order_id',
            batch_size: 500,
        },

        // Schema-specific table
        {
            name: 'audit.logs',
            timestamp_column: 'logged_at',
            batch_size: 200,
        },
    ],
})
```

## Table Naming

The plugin prefixes all synced tables with `tmp_` to distinguish them from user-created tables:

- `users` → `tmp_users`
- `public.products` → `tmp_products`
- `audit.logs` → `tmp_audit_logs`

## Monitoring

Monitor sync status using the provided endpoints:

```bash
# Check sync status
curl http://localhost:8787/sync-status

# View synced data
curl http://localhost:8787/sync-data

# Debug information
curl http://localhost:8787/debug
```

## Error Handling

The plugin provides comprehensive error handling:

- Failed records are logged but don't stop the sync process
- Sync errors are stored in metadata
- Automatic retries on next sync interval
- Detailed error logging with context

## Extending

Support for new databases can be added by implementing the `DatabaseSyncSource` abstract class:

```typescript
class MySQLSyncSource extends DatabaseSyncSource {
    // Implement required methods
}
```

See the PostgreSQL implementation for a reference.
