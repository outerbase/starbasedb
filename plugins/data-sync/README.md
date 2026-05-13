# Data Sync Plugin

The Data Sync plugin provides the first reusable replication layer for pulling
rows from the configured external source into StarbaseDB's internal SQLite
database.

It focuses on the core mechanics needed by issue #72:

- table allowlists
- cursor-based incremental pulls
- bounded batches
- external SQL select planning for PostgreSQL, MySQL, and SQLite sources
- internal SQLite insert/upsert planning
- checkpoint and run-history tables
- an authenticated admin run endpoint at `/data-sync/run`

## Example

```ts
import { DataSyncPlugin } from '@outerbase/starbasedb/plugins'

const plugin = new DataSyncPlugin([
    {
        sourceTable: 'public.users',
        targetTable: 'public_users',
        cursorColumn: 'updated_at',
        primaryKeyColumns: ['id'],
        columns: ['id', 'email', 'updated_at'],
        batchSize: 500,
    },
])
```

When `runOnce()` or `POST /data-sync/run` is called, the plugin reads the last
stored checkpoint, pulls rows with `cursorColumn > checkpoint`, writes each row
to internal SQLite, then stores the newest cursor value.

The checkpoint and run-history tables are internal implementation details:

- `tmp_data_sync_checkpoints`
- `tmp_data_sync_runs`
