# Replication Plugin

Pull rows from a configured external data source into the internal Durable Object SQLite database so StarbaseDB can serve as a close-to-edge read replica.

```ts
import { ReplicationPlugin } from '@outerbase/starbasedb/plugins'

new ReplicationPlugin({
    defaultIntervalSeconds: 60,
    tables: [
        {
            sourceTable: 'public.users',
            targetTable: 'users',
            columns: ['id', 'email', 'created_at', 'updated_at'],
            cursorColumn: 'updated_at',
            cursorValueType: 'date',
            primaryKey: 'id',
            batchSize: 500,
            mode: 'upsert',
        },
    ],
})
```

The plugin expects `dataSource.source` to be `internal` and `dataSource.external` to contain the remote database connection. It stores cursor state in `tmp_starbasedb_replication_state`, records each run in `tmp_starbasedb_replication_runs`, and can be triggered manually with `POST /replication/pull` or `POST /replication/pull/:tableName`.

Manual replication routes require an admin request. Set `autoPull: false` to disable interval checks before queries and rely only on the pull routes. Static `where` clauses are supported for trusted application configuration; table and column identifiers are validated before SQL is generated.

Incremental tables must configure a `cursorColumn` plus either `primaryKey` or `cursorTieBreakerColumn`. The plugin stores both cursor and tie-breaker values so repeated cursor values across a batch boundary are not skipped. Tables without a cursor are treated as full refreshes and are selected without a batch limit.
