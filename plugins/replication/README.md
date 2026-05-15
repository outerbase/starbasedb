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

Set `autoPull: false` to disable interval checks before queries and rely only on the authenticated pull routes. Static `where` clauses are supported for trusted application configuration; table and column identifiers are validated before SQL is generated.

