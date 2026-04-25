# Replication Plugin

Pull-based data replication plugin for StarbaseDB. Replicates data from an external data source (e.g., PostgreSQL on Supabase) into the internal Durable Object SQLite, turning the StarbaseDB instance into a close-to-edge read replica.

## Features

- **Pull-based replication**: Periodically polls external data sources for new or updated rows
- **Configurable intervals**: Set custom sync intervals per table (in seconds)
- **Append-only tracking**: Uses a cursor column (`id`, `created_at`, etc.) to efficiently fetch only new data
- **Multi-table support**: Replicate specific tables, not necessarily your entire database
- **REST API**: Configure replication via HTTP endpoints
- **Event callbacks**: Programmatically subscribe to replication events

## Configuration

### Via REST API

**Add a table to replication:**

```bash
curl -X POST https://your-endpoint/replication/config \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "source_table": "users",
    "target_table": "users",
    "cursor_column": "id",
    "interval_seconds": 60
  }'
```

**List replicated tables:**

```bash
curl https://your-endpoint/replication/config \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

**Remove a table from replication:**

```bash
curl -X DELETE https://your-endpoint/replication/config/users \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

**Trigger immediate sync:**

```bash
curl -X POST https://your-endpoint/replication/sync \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

**Check replication status:**

```bash
curl https://your-endpoint/replication/status \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN"
```

### Via Code (in `src/index.ts`)

```typescript
import { ReplicationPlugin } from '../plugins/replication'

const replicationPlugin = new ReplicationPlugin()

// Subscribe to replication events
replicationPlugin.onEvent(async ({ source_table, rows_synced }) => {
    console.log(`Synced ${rows_synced} rows from ${source_table}`)
}, ctx)

// Add to plugins array
const plugins = [
    // ...existing plugins,
    replicationPlugin,
]
```

## How It Works

1. On each sync interval (driven via the Cron plugin or Durable Object alarms):
   - For each configured table, the plugin queries the external data source for rows where `cursor_column > last_cursor_value`
   - Fetched rows are inserted into the internal SQLite database using `INSERT OR REPLACE`
   - The cursor value is updated to track the latest synced position
2. The plugin creates mirrored tables in SQLite automatically by inspecting the external schema
3. All replication state is persisted in `tmp_replication_config` and `tmp_replication_state` tables

## Requirements

- An external data source must be configured in `wrangler.toml`
- The external data source must be one of: PostgreSQL, MySQL, Turso, StarbaseDB, or Cloudflare D1
