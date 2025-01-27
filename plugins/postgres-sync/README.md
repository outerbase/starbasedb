# PostgreSQL Sync Source

A PostgreSQL implementation of the DatabaseSyncSource for the StarbaseDB Data Sync plugin. This plugin enables synchronization of data from PostgreSQL databases to StarbaseDB's internal SQLite database.

## Features

- PostgreSQL-specific schema and type handling
- Support for all major PostgreSQL data types
- Schema-aware table synchronization
- Comprehensive type mapping to SQLite
- Array type support (stored as JSON)
- Default value handling
- Sequence handling for auto-increment fields

## Installation

```toml
# wrangler.toml
[plugins.data-sync]
sync_interval = 300
tables = ["users", "products"]

[plugins.postgres-sync]
schema = "public"  # optional, defaults to "public"
```

## Configuration

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

```typescript
import { DataSyncPlugin } from '@starbasedb/data-sync'
import { PostgresSyncSource } from '@starbasedb/postgres-sync'

// Create PostgreSQL sync source
const postgresSync = new PostgresSyncSource({
    dialect: 'postgresql',
    schema: 'public', // optional
})

// Create data sync plugin with PostgreSQL source
const dataSyncPlugin = new DataSyncPlugin(postgresSync, {
    sync_interval: 300,
    tables: ['users', 'products'],
})

// Register with your app
app.register(dataSyncPlugin)
```

## Type Mapping

PostgreSQL types are automatically mapped to SQLite types:

| PostgreSQL Type           | SQLite Type |
| ------------------------- | ----------- |
| integer, bigint, smallint | INTEGER     |
| text, varchar, char       | TEXT        |
| boolean                   | INTEGER     |
| timestamp, date           | TEXT        |
| numeric, decimal, real    | REAL        |
| json, jsonb               | TEXT        |
| uuid                      | TEXT        |
| bytea                     | BLOB        |
| array types               | TEXT (JSON) |
| interval                  | TEXT        |
| point, line, polygon      | TEXT        |
| cidr, inet, macaddr       | TEXT        |
| bit, bit varying          | INTEGER     |
| money                     | REAL        |
| xml                       | TEXT        |

## Schema Support

The plugin supports PostgreSQL schemas:

```typescript
const dataSyncPlugin = new DataSyncPlugin(postgresSync, {
    tables: [
        'public.users', // public schema
        'analytics.events', // custom schema
        {
            name: 'audit.logs', // schema in config
            timestamp_column: 'logged_at',
        },
    ],
})
```

## Default Value Handling

- Sequence defaults (`nextval`) are converted to SQLite auto-increment
- Type-cast defaults are properly parsed
- NULL defaults are preserved
- Constant values are preserved

## Validation

The plugin validates:

- Table existence in specified schema
- Column existence and types
- Timestamp column types
- Required sync columns (timestamp or ID)

## Error Handling

Comprehensive error handling for:

- Connection issues
- Schema validation
- Type mapping
- Query execution
- Data conversion

## Requirements

- PostgreSQL 9.5 or later
- Tables must have either:
    - A timestamp column for time-based syncing
    - An ID column for incremental syncing
- Access to `information_schema` for metadata

## Testing

Start a PostgreSQL instance:

```bash
docker run --name starbasedb-postgres \
    -e POSTGRES_PASSWORD=postgres \
    -e POSTGRES_DB=demo \
    -p 5432:5432 \
    -d postgres:15
```
