# DataSync Plugin

Incrementally replicate rows from an external database into your StarbaseDB (SQLite) instance using an append-only cursor column. Each supported engine ships as a **DataSyncAdapter** subclass — so adding a new source means subclassing one interface, not touching the plugin core.

## Supported Sources

| Adapter | Import |
|---------|--------|
| PostgreSQL | `PostgresSync` |
| MySQL / MariaDB | `MySQLSync` |

## Installation

```typescript
import { DataSyncPlugin, PostgresSync } from '../plugins/data-sync'

const plugins = [
    // ... other plugins
    new DataSyncPlugin({
        source: new PostgresSync({
            host: 'db.example.com',
            port: 5432,
            user: 'readonly',
            password: process.env.PG_PASSWORD!,
            database: 'production',
        }),
        tables: [
            { tableName: 'public.users',   trackingColumn: 'id' },
            { tableName: 'public.orders',  trackingColumn: 'created_at' },
        ],
        syncIntervalMs: 60_000, // poll every minute (default: 5 min)
    }),
] satisfies StarbasePlugin[]
```

## Configuration Options

### `DataSyncPluginOptions`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `source` | `DataSyncAdapter` | — | Database adapter (PostgresSync, MySQLSync, …) |
| `tables` | `TableSyncConfig[]` | — | List of tables to replicate |
| `syncIntervalMs` | `number` | `300000` | Poll interval in milliseconds |

### `TableSyncConfig`

| Option | Type | Description |
|--------|------|-------------|
| `tableName` | `string` | Fully-qualified (`public.users`) or plain (`users`) table name |
| `trackingColumn` | `string` | Monotonically increasing column used as the sync cursor (`id`, `created_at`, …) |

### PostgresSync options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `host` | `string` | — | PostgreSQL host |
| `port` | `number` | `5432` | PostgreSQL port |
| `user` | `string` | — | Database username |
| `password` | `string` | — | Database password |
| `database` | `string` | — | Database name |
| `ssl` | `boolean` | `false` | Enable SSL/TLS |

### MySQLSync options

Same as PostgresSync but defaults `port` to `3306`.

## How It Works

1. **Schema discovery** — on first sync the adapter calls `getColumns()` and the plugin creates a matching SQLite table (schema prefix stripped).
2. **Cursor tracking** — progress is stored in `tmp_data_sync_metadata` so syncs resume where they left off after restarts.
3. **Incremental fetch** — only rows where `trackingColumn > lastValue` are fetched, keeping payloads small.
4. **Alarm-based scheduling** — Cloudflare Durable Object alarms reschedule the next sync automatically.

## Custom Adapters

Extend `DataSyncAdapter` and implement three methods:

```typescript
import { DataSyncAdapter, ColumnInfo } from '../plugins/data-sync'

export class MyDBSync extends DataSyncAdapter {
    async getColumns(tableName: string): Promise<ColumnInfo[]> { /* ... */ }
    async fetchRows(opts: { tableName: string; trackingColumn: string; lastValue: string | null; limit?: number }): Promise<Record<string, unknown>[]> { /* ... */ }
    mapType(nativeType: string): string { /* ... */ }
}
```
