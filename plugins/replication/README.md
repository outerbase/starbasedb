# ReplicationPlugin

Pull-based replication plugin for StarbaseDB that incrementally synchronizes tables from an external data source (PostgreSQL, MySQL, Turso, Cloudflare D1, or Outerbase API) into the internal Durable Object SQLite database.

## Usage

```ts
import { ReplicationPlugin } from '@outerbase/starbasedb/plugins'

const replication = new ReplicationPlugin({
    intervalMs: 60000,
    tables: [
        {
            table: 'users',
            cursorColumn: 'updated_at',
            primaryKey: 'id',
            batchSize: 500,
        },
    ],
})
```
