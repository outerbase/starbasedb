# Replication Plugin

Pulls data from an external database into the internal SQLite on a schedule, keeping a local edge replica in sync.

## Setup

Configure your external database in `wrangler.toml`, then add the plugin in `src/index.ts`:

```ts
import { ReplicationPlugin } from '../plugins/replication'

const replicationPlugin = new ReplicationPlugin({
    tables: [
        { name: 'users', cursorColumn: 'id' },
        { name: 'orders', cursorColumn: 'created_at', batchSize: 500 },
    ],
})

cronPlugin.onEvent(async ({ name }) => {
    if (name === 'replication') await replicationPlugin.runSync()
}, ctx)

// Add replicationPlugin to the plugins array
```

Then register a cron task to trigger sync periodically:

```sh
curl -X POST https://your-worker.dev/cron \
  -H "Authorization: Bearer ABC123" \
  -H "Content-Type: application/json" \
  -d '{"name":"replication","cron_tab":"0 * * * *","payload":{},"callback_host":"https://your-worker.dev"}'
```

## Options

| Option                  | Default  | Description                          |
| ----------------------- | -------- | ------------------------------------ |
| `tables[].name`         | required | Table name in external DB            |
| `tables[].cursorColumn` | `"id"`   | Column used to track last synced row |
| `tables[].batchSize`    | `1000`   | Rows fetched per sync run            |

## Endpoints

| Method | Path                  | Description                |
| ------ | --------------------- | -------------------------- |
| `POST` | `/replication/sync`   | Trigger a sync manually    |
| `GET`  | `/replication/status` | View last cursor per table |
