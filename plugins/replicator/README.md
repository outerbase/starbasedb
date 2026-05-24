# Replicator Plugin

The Replicator Plugin pulls rows from an external database (Postgres, MySQL, Cloudflare D1, Turso, or another StarbaseDB) into StarbaseDB's internal SQLite store on demand. Each replication pass uses a per-table watermark column (e.g. `updated_at` or a monotonic `id`) so that only rows that changed since the previous run are transferred.

## Usage

```ts
import { ReplicatorPlugin } from '../plugins/replicator'

const replicatorPlugin = new ReplicatorPlugin({
    external: {
        dialect: 'postgresql',
        host: env.EXTERNAL_DB_HOST!,
        port: env.EXTERNAL_DB_PORT!,
        user: env.EXTERNAL_DB_USER!,
        password: env.EXTERNAL_DB_PASS!,
        database: env.EXTERNAL_DB_DATABASE!,
    },
    tables: [
        {
            name: 'users',
            watermarkColumn: 'updated_at',
            primaryKey: 'id',
        },
        {
            name: 'orders',
            watermarkColumn: 'id',
            primaryKey: 'id',
            destTable: 'orders_mirror',
        },
    ],
    batchSize: 500,
})

const plugins = [
    replicatorPlugin,
    // ... other plugins
] satisfies StarbasePlugin[]
```

## How To Use

Trigger a replication pass with an admin-authorized POST request:

```bash
curl -X POST https://<your-starbase-instance>/replicator/sync \
    -H "Authorization: Bearer $ADMIN_AUTHORIZATION_TOKEN"
```

Each call returns at most `batchSize` rows per table, so the initial
backfill of a large table will require several invocations until every
table reports `rowsReplicated: 0`.

### Bootstrapping the destination table

The replicator does not migrate schemas. Create the destination table on
the StarbaseDB side before the first sync — for example:

```sql
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    name TEXT,
    updated_at TEXT NOT NULL
);
```

The primary key column you pass to the plugin must be the `PRIMARY KEY`
(or have a `UNIQUE` index) so that `ON CONFLICT(...) DO UPDATE` works.

### Scheduling with the Cron plugin

Pair the replicator with the [Cron plugin](/plugins/cron/README.md) so
that `sync()` runs on a schedule:

```ts
import { CronPlugin } from '../plugins/cron'
import { ReplicatorPlugin } from '../plugins/replicator'

const replicatorPlugin = new ReplicatorPlugin({
    /* ...as above... */
})

const cronPlugin = new CronPlugin()
cronPlugin.onEvent(async ({ name }) => {
    if (name === 'Replicate every minute') {
        await replicatorPlugin.sync()
    }
}, ctx)

const plugins = [
    cronPlugin,
    replicatorPlugin,
] satisfies StarbasePlugin[]
```

Then insert a matching task row into `tmp_cron_tasks` (see the Cron
plugin README for the schema).

## Configuration Options

| Option       | Type                    | Default       | Description                                                                                            |
| ------------ | ----------------------- | ------------- | ------------------------------------------------------------------------------------------------------ |
| `external`   | `ExternalDatabaseSource` | required      | Connection details for the external database to replicate from.                                       |
| `tables`     | `ReplicationTable[]`    | required      | List of tables to replicate. See below.                                                                |
| `batchSize`  | `number`                | `1000`        | Maximum number of rows to pull per table per `sync()` call.                                            |
| `pathPrefix` | `string`                | `/replicator` | URL prefix for the plugin's HTTP routes.                                                               |

### `ReplicationTable`

| Field             | Type     | Default    | Description                                                                              |
| ----------------- | -------- | ---------- | ---------------------------------------------------------------------------------------- |
| `name`            | `string` | required   | The table name in the external source.                                                   |
| `watermarkColumn` | `string` | required   | Column used to track replication progress (e.g. `updated_at`, monotonic `id`).           |
| `primaryKey`      | `string` | required   | Column used for upserting rows on the destination side.                                  |
| `destTable`       | `string` | `name`     | (optional) The destination table name inside StarbaseDB. Defaults to the source name. |

## How It Works

1. On registration the plugin creates `tmp_replication_state(table_name, last_value, last_synced_at)` to track the most recent watermark seen per table.
2. On each `sync()` call the plugin reads the stored watermark, runs `SELECT * FROM <table> WHERE <watermarkColumn> > <last_value> ORDER BY <watermarkColumn> ASC LIMIT <batchSize>` against the external source, and upserts the rows into the internal SQLite store using `ON CONFLICT(<primaryKey>) DO UPDATE`.
3. After all rows are written, the highest watermark observed becomes the new stored `last_value`. Watermark comparison is numeric when both sides parse as numbers (so `id = 100` correctly ranks above `id = 99`) and lexicographic otherwise (which already handles ISO timestamps such as `updated_at`).

> [!NOTE]
> The destination table must already exist with the matching schema (including the primary key). The replicator does not create or migrate tables on the StarbaseDB side.

> [!NOTE]
> Table and column identifiers are validated at construction time and must match `[A-Za-z_][A-Za-z0-9_]*`. Identifiers containing spaces, hyphens, quotes or reserved characters are not supported.
