# Data Replication Plugin

The Data Replication Plugin for StarbaseDB pulls data from external databases (PostgreSQL, MySQL, SQLite/Turso/D1) into the internal Durable Object SQLite store, creating a close-to-edge replica for fast local queries.

## Usage

Add the DataReplicationPlugin to your Starbase configuration:

```typescript
import { DataReplicationPlugin } from './plugins/data-replication'

const replicationPlugin = new DataReplicationPlugin({ stub })

const plugins = [
    // ... other plugins
    replicationPlugin,
] satisfies StarbasePlugin[]
```

## Configuration Options

| Option | Type                | Default | Description                                     |
| ------ | ------------------- | ------- | ----------------------------------------------- |
| `stub` | `DurableObjectStub` | `null`  | Reference to the Durable Object stub for alarms |

## Sync Modes

- **Incremental (cursor-based)**: Set a `cursor_column` (e.g. `id`, `created_at`) to only fetch new rows since the last sync.
- **Full replacement**: Omit `cursor_column` to delete and re-insert all rows on each cycle.

## API Endpoints

| Method | Path                       | Description                          |
| ------ | -------------------------- | ------------------------------------ |
| POST   | `/replication/configs`     | Create a replication config          |
| GET    | `/replication/configs`     | List all replication configs         |
| GET    | `/replication/configs/:id` | Get a specific config                |
| PUT    | `/replication/configs/:id` | Update a config                      |
| DELETE | `/replication/configs/:id` | Delete a config and its sync state   |
| GET    | `/replication/status`      | Get sync state for all configs       |
| GET    | `/replication/status/:id`  | Get sync state for a specific config |
| POST   | `/replication/sync/:id`    | Manually trigger sync for a config   |
| POST   | `/replication/callback`    | Internal callback from DO alarm      |

## Creating a Replication Config

```bash
curl -X POST https://your-endpoint/replication/configs \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "source_table": "users",
    "target_table": "users_replica",
    "cursor_column": "id",
    "interval_seconds": 300,
    "enabled": true,
    "callback_host": "https://your-endpoint"
  }'
```

## Manual Sync

```bash
curl -X POST https://your-endpoint/replication/sync/1 \
  -H "Authorization: Bearer YOUR_TOKEN"
```
