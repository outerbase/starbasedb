# Data Sync Plugin for StarbaseDB

This plugin synchronizes data from external databases to StarbaseDB's internal SQLite database. It provides a pull mechanism to replicate data from various external sources like PostgreSQL, MySQL, MongoDB, Turso, and Cloudflare D1.

## Features

- **Automatic Synchronization**: Periodically pulls data from external databases
- **Incremental Updates**: Only fetches new or updated records since the last sync
- **Schema Detection**: Automatically detects and creates matching table schemas
- **Selective Sync**: Configure which tables to synchronize
- **Batch Processing**: Processes data in configurable batch sizes
- **Multiple Database Support**: Works with PostgreSQL, MySQL, MongoDB, Turso, Cloudflare D1, and other StarbaseDB instances

## Installation

1. Add the Data Sync Plugin to your StarbaseDB instance:

```bash
npm install @starbasedb/plugin-data-sync
```

2. Register the plugin in your StarbaseDB configuration:

```javascript
import { StarbaseDB } from '@starbasedb/core'
import { DataSyncPlugin } from '@starbasedb/plugin-data-sync'

const starbase = new StarbaseDB({
    plugins: [new DataSyncPlugin()],
})
```

## Configuration

Configure the plugin in your StarbaseDB instance settings:

```json
{
    "sync_interval": 15,
    "tables": ["users", "products"],
    "batch_size": 1000,
    "track_column": "created_at",
    "enabled": true
}
```

### Configuration Options

| Option          | Type    | Description                                            | Default      |
| --------------- | ------- | ------------------------------------------------------ | ------------ |
| `sync_interval` | number  | Interval in minutes between synchronization runs       | 15           |
| `tables`        | array   | List of tables to synchronize (empty means all tables) | []           |
| `batch_size`    | number  | Number of records to fetch in each batch               | 1000         |
| `track_column`  | string  | Column to track for incremental updates                | "created_at" |
| `enabled`       | boolean | Enable or disable synchronization                      | true         |

## External Database Configuration

Configure your external database connection in your `wrangler.toml` file:

### PostgreSQL

```toml
# PostgreSQL configuration
EXTERNAL_DB_TYPE = "postgresql"
EXTERNAL_DB_HOST = "your-db-host"
EXTERNAL_DB_PORT = "5432"
EXTERNAL_DB_USER = "username"
EXTERNAL_DB_PASS = "password"
EXTERNAL_DB_DATABASE = "database_name"
EXTERNAL_DB_DEFAULT_SCHEMA = "public"
```

### MySQL

```toml
# MySQL configuration
EXTERNAL_DB_TYPE = "mysql"
EXTERNAL_DB_HOST = "your-db-host"
EXTERNAL_DB_PORT = "3306"
EXTERNAL_DB_USER = "username"
EXTERNAL_DB_PASS = "password"
EXTERNAL_DB_DATABASE = "database_name"
```

### MongoDB

```toml
# MongoDB configuration
EXTERNAL_DB_TYPE = "mongodb"
EXTERNAL_DB_MONGODB_URI = "mongodb://username:password@host:port/database"
```

### Turso

```toml
# Turso configuration
EXTERNAL_DB_TYPE = "turso"
EXTERNAL_DB_TURSO_URI = "libsql://your-database.turso.io"
EXTERNAL_DB_TURSO_TOKEN = "your-token"
```

### StarbaseDB

```toml
# StarbaseDB configuration
EXTERNAL_DB_TYPE = "starbasedb"
EXTERNAL_DB_STARBASEDB_URI = "https://your-instance.starbasedb.com"
EXTERNAL_DB_STARBASEDB_TOKEN = "your-token"
```

### Cloudflare D1

```toml
# Cloudflare D1 configuration
EXTERNAL_DB_TYPE = "d1"
EXTERNAL_DB_CLOUDFLARE_API_KEY = "your-api-key"
EXTERNAL_DB_CLOUDFLARE_ACCOUNT_ID = "your-account-id"
EXTERNAL_DB_CLOUDFLARE_DATABASE_ID = "your-database-id"
```

## API Methods

The plugin exposes the following methods for programmatic control:

### Get Sync Status

```javascript
const status = await starbase.plugins.dataSync.getSyncStatus()
console.log(status)
```

Returns:

```json
{
    "lastSyncTime": "2023-06-15T14:30:00.000Z",
    "tableMap": {
        "users": {
            "lastValue": "2023-06-15T14:25:00.000Z",
            "recordCount": 1250
        },
        "products": {
            "lastValue": "2023-06-15T13:45:00.000Z",
            "recordCount": 350
        }
    },
    "isRunning": false
}
```

### Trigger Manual Sync

```javascript
// Sync all configured tables
await starbase.plugins.dataSync.triggerSync()

// Sync specific tables
await starbase.plugins.dataSync.triggerSync(['users', 'orders'])
```

Manually triggers a synchronization run for all or specific tables.

### Reset Sync State

```javascript
// Reset a specific table
await starbase.plugins.dataSync.resetSyncState('users')

// Reset all tables
await starbase.plugins.dataSync.resetSyncState()
```

Resets the synchronization state, causing the next sync to start from scratch.

## Event Hooks

The plugin emits events that you can listen to:

```javascript
// Listen for sync start
starbase.plugins.dataSync.on('syncStart', () => {
    console.log('Sync started')
})

// Listen for sync completion
starbase.plugins.dataSync.on('syncComplete', (stats) => {
    console.log('Sync completed', stats)
})

// Listen for sync errors
starbase.plugins.dataSync.on('syncError', (error) => {
    console.error('Sync error', error)
})
```

## Example Usage

### Basic Setup

1. Configure the plugin in your StarbaseDB instance
2. Set up your external database connection in `wrangler.toml`
3. The plugin will automatically start syncing data based on your configuration

### Custom Query Hook

You can create a custom query hook to use the synced data:

```javascript
starbase.hooks.onQuery.add(async (query, context) => {
    // Check if query is for a synced table
    if (query.includes('FROM users')) {
        // You can modify the query or add custom logic
        return context.db.all(query)
    }

    // Continue with normal query processing
    return null
})
```

### Sync with Custom Logic

```javascript
// Custom sync function
async function syncUserData() {
    // Get current sync status
    const status = await starbase.plugins.dataSync.getSyncStatus()

    // Only sync if last sync was more than an hour ago
    const lastSync = new Date(status.lastSyncTime)
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000)

    if (lastSync < oneHourAgo) {
        console.log('Starting user data sync...')
        await starbase.plugins.dataSync.triggerSync(['users'])
        console.log('User data sync completed')
    }
}
```

## Troubleshooting

### Common Issues

1. **Sync Not Working**: Check your external database credentials and connection

    ```
    Data Sync Plugin: Failed to connect to external database
    Error: connect ECONNREFUSED 127.0.0.1:5432
    ```

    Solution: Verify your database host, port, and credentials in wrangler.toml

2. **Missing Tables**: Ensure the tables exist in your external database

    ```
    Data Sync Plugin: Table 'products' not found in external database
    ```

    Solution: Check table names and case sensitivity

3. **Slow Sync**: Try reducing the batch size or increasing the sync interval

    ```
    Data Sync Plugin: Sync taking longer than expected (45s)
    ```

    Solution: Adjust batch_size in configuration

4. **Schema Mismatch**: Column types may not map correctly
    ```
    Data Sync Plugin: Failed to create table 'users'
    Error: Cannot map external type 'jsonb' to SQLite type
    ```
    Solution: Use simpler data types or add custom type mapping

### Viewing Logs

Check the StarbaseDB logs for detailed information about sync operations:

```
Data Sync Plugin: Starting synchronization
Data Sync Plugin: Found 3 tables to sync
Data Sync Plugin: Syncing table users
Data Sync Plugin: Created table users
Data Sync Plugin: Synced 100 records for table users
```

Enable debug logging for more detailed information:

```javascript
starbase.setLogLevel('debug')
```

## Performance Considerations

- **Large Tables**: For tables with millions of records, consider using a smaller batch size
- **Frequent Updates**: For tables that change frequently, use a shorter sync interval
- **Complex Schemas**: Tables with many columns may require more memory during sync

## Security

- The plugin uses the credentials specified in your wrangler.toml file
- Consider using read-only database users for the external database connection
- All data is transferred securely through your configured connections

## Demo

A demo script is included to test the plugin functionality:

1. Run the setup SQL script in your PostgreSQL database:

    ```
    psql -U postgres -d your_database -f plugins/data_sync/demo/setup.sql
    ```

2. Run the demo script:
    ```
    ts-node plugins/data_sync/demo/test.ts
    ```

## License

This plugin is part of StarbaseDB and is subject to the same license terms.
