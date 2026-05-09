
# Data Replicator Plugin

This plugin replicates data from external sources to the internal SQLite database in StarbaseDB.

## Features

- Configurable pull interval
- Table-specific replication
- Append-only polling mechanism
- Tracking of last replicated items

## Configuration

The plugin uses the following environment variables:

- `REPLICATION_INTERVAL` - Interval in seconds for data pulling (default: 300)
- `REPLICATION_TABLES` - Comma-separated list of tables to replicate (default: all tables)

## Usage

1. Configure the external database connection using the `EXTERNAL_DB_*` environment variables
2. Set the `REPLICATION_INTERVAL` and `REPLICATION_TABLES` environment variables as needed
3. The plugin will automatically start replicating data from the external source to the internal SQLite database
