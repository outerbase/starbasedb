# Data Sync Plugin

The Data Sync plugin enables automatic synchronization of data from external data sources (like PostgreSQL) to StarbaseDB's internal SQLite database. This plugin is useful for creating a close-to-edge replica of your data that can be queried as an alternative to querying the external database directly.

## Features

- Automatic synchronization of specified tables from external to internal database
- Configurable sync interval
- Incremental updates based on timestamps and IDs
- Automatic schema mapping from PostgreSQL to SQLite types
- Persistent tracking of sync state
- Graceful handling of connection issues and errors
- Query interception hooks for monitoring and modification
- Debug endpoints for monitoring sync status

## Installation

The plugin is included in the StarbaseDB core package. To use it, simply configure it in your `wrangler.toml` file:

```toml
[plugins.data-sync]
sync_interval = 300  # Sync interval in seconds (default: 300)
tables = ["users", "products"]  # List of tables to synchronize
```

## Configuration Options

| Option          | Type     | Description                                     | Default |
| --------------- | -------- | ----------------------------------------------- | ------- |
| `sync_interval` | number   | The interval in seconds between sync operations | 300     |
| `tables`        | string[] | Array of table names to synchronize             | []      |

## How It Works

1. The plugin creates a metadata table in the internal database to track sync state
2. For each configured table:
    - Retrieves the table schema from the external database
    - Creates a corresponding table in the internal database
    - Periodically checks for new or updated records based on `created_at` timestamp and `id`
    - Syncs new data to the internal database
    - Updates the sync state in the metadata table
3. Provides hooks for query interception:
    - `beforeQuery`: For monitoring or modifying queries before execution
    - `afterQuery`: For processing results after query execution

## Requirements

- The external database tables must have:
    - A `created_at` timestamp column for tracking changes
    - An `id` column (numeric or string) for tracking record identity
- The external database must support the `information_schema` for retrieving table metadata

## Type Mapping

The plugin automatically maps PostgreSQL types to SQLite types:

| PostgreSQL Type                          | SQLite Type |
| ---------------------------------------- | ----------- |
| integer, bigint                          | INTEGER     |
| text, varchar, char                      | TEXT        |
| boolean                                  | INTEGER     |
| timestamp, date                          | TEXT        |
| numeric, decimal, real, double precision | REAL        |
| json, jsonb                              | TEXT        |

## Example Usage

```typescript
import { DataSyncPlugin } from '@starbasedb/plugins/data-sync'

// Initialize the plugin
const dataSyncPlugin = new DataSyncPlugin({
    sync_interval: 300, // 5 minutes
    tables: ['users', 'orders'],
})

// Add to your StarbaseDB configuration
const config = {
    plugins: [dataSyncPlugin],
    // ... other config options
}
```

## Demo

A complete demo implementation is available in the `demo` directory. The demo shows:

- Setting up the plugin with PostgreSQL
- Using query hooks for monitoring
- Testing sync functionality
- Debugging and monitoring endpoints

See [Demo README](./demo/README.md) for detailed instructions.

## Limitations

- The plugin currently assumes the presence of `created_at` and `id` columns
- Large tables may take longer to sync initially
- Deleted records in the external database are not automatically removed from the internal database
- The sync operation is pull-based and runs on a fixed interval

## Security Notes

- Always use secure, randomly generated tokens for authentication
- Store sensitive credentials in environment variables
- In production, enable authentication and use secure database credentials
- The demo uses example tokens (like "ABC123") for illustration only

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
