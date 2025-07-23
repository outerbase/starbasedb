# Data Replication Plugin

The Data Replication Plugin allows StarbaseDB to pull data from external databases (PostgreSQL, MySQL, etc.) into the internal SQLite database with configurable sync intervals and incremental updates.

## Features

- **External Database Support**: Connect to PostgreSQL, MySQL, and other external databases
- **Incremental Sync**: Track changes using ID or timestamp columns for efficient updates
- **Configurable Intervals**: Set custom sync intervals per replication configuration
- **Table-Specific Replication**: Replicate specific tables from external sources
- **Logging & Monitoring**: Comprehensive logs of sync operations and status
- **Event Callbacks**: Register callbacks for replication events
- **REST API**: Full API for managing replication configurations

## Configuration

### Setting up a Replication Configuration

```javascript
// POST /data-replication/configure
{
  "name": "supabase-users",
  "sourceConfig": {
    "dialect": "postgresql",
    "host": "your-project.supabase.co",
    "port": 5432,
    "user": "postgres",
    "password": "your-password",
    "database": "postgres",
    "defaultSchema": "public"
  },
  "targetTable": "users",
  "sourceTable": "users",
  "syncIntervalMinutes": 30,
  "trackingColumn": "updated_at",
  "isActive": true
}
```

### External Database Configuration

The plugin supports various external database types:

#### PostgreSQL

```javascript
{
  "dialect": "postgresql",
  "host": "localhost",
  "port": 5432,
  "user": "username",
  "password": "password",
  "database": "dbname",
  "defaultSchema": "public"
}
```

#### MySQL

```javascript
{
  "dialect": "mysql",
  "host": "localhost",
  "port": 3306,
  "user": "username",
  "password": "password",
  "database": "dbname"
}
```

#### Hyperdrive (Cloudflare)

```javascript
{
  "dialect": "postgresql",
  "connectionString": "postgresql://user:pass@host:port/db"
}
```

## API Endpoints

### Configure Replication

- **POST** `/data-replication/configure`
- Set up a new replication configuration

### Start/Stop Replication

- **POST** `/data-replication/start/:name` - Start replication for a specific config
- **POST** `/data-replication/stop/:name` - Stop replication for a specific config

### Manual Sync

- **POST** `/data-replication/sync/:name` - Trigger immediate sync

### Status & Monitoring

- **GET** `/data-replication/status` - Get all replication configurations and their status
- **GET** `/data-replication/logs?limit=50` - Get replication logs

### Delete Configuration

- **DELETE** `/data-replication/configure/:name` - Remove a replication configuration

## Usage Examples

### Basic Setup

```javascript
// Configure replication from Supabase to local table
const config = {
    name: 'product-catalog',
    sourceConfig: {
        dialect: 'postgresql',
        host: 'your-project.supabase.co',
        port: 5432,
        user: 'postgres',
        password: process.env.SUPABASE_PASSWORD,
        database: 'postgres',
        defaultSchema: 'public',
    },
    targetTable: 'products',
    sourceTable: 'products',
    syncIntervalMinutes: 60,
    trackingColumn: 'id',
}

fetch('/data-replication/configure', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
})
```

### Event Handling

```javascript
// Register callback for replication events
dataReplicationPlugin.onEvent((payload) => {
    console.log(`Replication ${payload.config_name}: ${payload.status}`)
    console.log(
        `Processed ${payload.records_processed} records in ${payload.sync_duration_ms}ms`
    )

    if (payload.status === 'error') {
        console.error('Replication error:', payload.error_message)
    }
})
```

## Tracking Columns

The plugin uses tracking columns to perform incremental synchronization:

- **ID-based tracking**: Use auto-incrementing IDs (recommended for INSERT-only data)
- **Timestamp-based tracking**: Use `created_at` or `updated_at` columns (recommended for UPDATE operations)

The plugin will only pull records where the tracking column value is greater than the last synced value.

## Database Tables

The plugin creates two internal tables:

### `tmp_replication_configs`

Stores replication configurations including source database details, sync intervals, and tracking information.

### `tmp_replication_logs`

Stores logs of sync operations including status, records processed, and error messages.

## Error Handling

- Failed sync operations are logged with error details
- Replication continues on schedule even after errors
- Event callbacks are triggered for both success and error states
- External database connection failures are handled gracefully

## Security Notes

- External database credentials are stored in the configuration
- Only authenticated admin users can manage replication configurations
- Passwords and sensitive data should be managed through environment variables
- Consider using read-only database users for external connections

## Limitations

- This is a pull-only replication system (no bidirectional sync)
- Large initial syncs may take time depending on data volume
- External database connectivity depends on network access from the Cloudflare Worker environment
