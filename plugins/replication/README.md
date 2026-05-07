# Replication Plugin

Pull-based replication from any external data source already supported by
StarbaseDB (Postgres, MySQL, Cloudflare D1, Turso, StarbaseDB-on-StarbaseDB,
Hyperdrive) into the Durable Object's internal SQLite. Closes #72.

The plugin is intentionally minimal: it composes existing primitives instead
of re-implementing them.

| Concern                                              | What we reuse                                                                                                                                      |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source connectors (PG, MySQL, D1, Turso, Hyperdrive) | `executeExternalQuery` from `src/operation.ts` and the existing `ExternalDatabaseSource` types from `src/types.ts`                                 |
| Internal SQLite writes                               | `dataSource.rpc.executeQuery` (same path every other plugin uses)                                                                                  |
| Scheduling                                           | Either the existing `CronPlugin` (`onEvent` callback) or the Worker's native `scheduled()` cron triggers - **the plugin does not own a scheduler** |
| Auth                                                 | Inherits the existing role check (`config.role === 'admin'`)                                                                                       |

## Configuration

```ts
import { ReplicationPlugin } from '../plugins/replication'

const replication = new ReplicationPlugin({
    sourceId: 'supabase-prod', // optional; default 'default'
    pageSize: 500, // optional; default 500
    source: {
        // optional; falls back to dataSource.external
        dialect: 'postgresql',
        host: 'db.acme.com',
        port: 5432,
        user: 'replicator',
        password: env.SUPABASE_PASSWORD,
        database: 'app',
    },
    tables: [
        {
            table: 'users',
            cursorColumn: 'id', // append-only by id
        },
        {
            table: 'orders',
            cursorColumn: 'updated_at', // upsert by updated_at
            primaryKey: 'order_id',
        },
        {
            sourceTable: 'public_events',
            destTable: 'events',
            cursorColumn: 'seq',
            columns: ['seq', 'kind', 'payload'],
            pageSize: 1000,
        },
    ],
})
```

Add to your plugin list in `src/index.ts`:

```ts
const plugins = [
    /* ... existing plugins ... */
    replication,
] satisfies StarbasePlugin[]
```

## Triggering a tick

The plugin runs **one page per table per call**. This bounds runtime and
keeps every tick well under the Workers subrequest budget. You drive it from
one of three places, your choice:

### Option A - Cloudflare cron triggers (recommended)

In `wrangler.toml`:

```toml
[triggers]
crons = ["*/5 * * * *"]
```

In `src/index.ts`:

```ts
export default {
    async fetch(request, env, ctx) {
        /* unchanged */
    },
    async scheduled(event, env, ctx) {
        const { dataSource, config } = await buildDataSource(env, ctx)
        ctx.waitUntil(replication.tick({ dataSource, config }))
    },
} satisfies ExportedHandler<Env>
```

### Option B - The existing `CronPlugin`

```ts
cronPlugin.onEvent(async ({ name }) => {
    if (name === 'replication-tick') {
        await replication.tick()
    }
}, ctx)

await cronPlugin.addEvent('*/5 * * * *', 'replication-tick', {}, callbackHost)
```

### Option C - Manual / on-demand

```bash
curl -X POST https://your-worker/replicate/run \
    -H "Authorization: Bearer $ADMIN_AUTHORIZATION_TOKEN"
```

## Endpoints

| Method | Path                | Auth  | Purpose                                              |
| ------ | ------------------- | ----- | ---------------------------------------------------- |
| `POST` | `/replicate/run`    | admin | Run one tick across all configured tables            |
| `GET`  | `/replicate/status` | admin | Read current per-table cursors and last-run metadata |

## State model

A single table, `tmp_replication_state`, stored in the DO SQLite:

| Column             | Type    | Meaning                                               |
| ------------------ | ------- | ----------------------------------------------------- |
| `source_id`        | TEXT    | scopes one DO replicating from multiple sources       |
| `table_name`       | TEXT    | destination table name                                |
| `cursor_column`    | TEXT    | which source column drives polling                    |
| `cursor_value`     | TEXT    | last seen value (`NULL` until first tick)             |
| `last_run_ts`      | INTEGER | epoch millis of the last tick that touched this table |
| `last_rows_pulled` | INTEGER | row count from the last tick                          |
| `last_error`       | TEXT    | last error message (NULL on success)                  |

Cursor advancement happens **per row**, not per page. A mid-page failure
preserves the highest-seen cursor on the rows we already wrote, so the next
tick resumes after that point and doesn't re-fetch them.

## Safety

- **Identifier validation**: every table/column name is checked against
  `^[A-Za-z_][A-Za-z0-9_]*$` before it touches a SQL string. The plugin does
  not parameterise identifiers; it whitelists them.
- **Per-table isolation**: a thrown error on one table is caught, recorded,
  and does not stop replication of other tables in the same tick.
- **Bounded runtime**: one page per table per tick. Set `pageSize` low if
  your destination DO is on the small side.
- **Cursor-based, append/upsert**: no destructive sync, no DELETE
  propagation. If you need full-state mirror semantics, add a delete-tracking
  source column or extend the upsert SQL in `index.ts`.

## Tests

```bash
pnpm test plugins/replication
```

Tests cover construction validation, middleware registration, cursor
advancement across consecutive ticks, the "more pages available" flag,
empty-batch handling, per-table error isolation, identifier injection
rejection, and the no-source / no-dataSource error paths.
