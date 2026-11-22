# PostgreSQL Sync Source (`PostgresSyncSource`)

The PostgreSQL Sync Source adapter for StarbaseDB provides schema introspection, data type mapping, table structure validation, and incremental data fetching for external PostgreSQL databases (including Supabase, Neon, AWS RDS, Cloudflare Hyperdrive, and Outerbase API connections).

## Usage

```typescript
import { DataSyncPlugin } from '../data-sync'
import { PostgresSyncSource } from '../postgres-sync'

const syncStore = new PostgresSyncSource({
    dialect: 'postgresql',
    schema: 'public',
})

const dataSyncPlugin = new DataSyncPlugin(syncStore, {
    sync_interval: 60,
    tables: ['users', 'person'],
})
```

## Configuration Options

| Option    | Type           | Default        | Description                                        |
| --------- | -------------- | -------------- | -------------------------------------------------- |
| `dialect` | `'postgresql'` | `'postgresql'` | Database dialect identifier                        |
| `schema`  | `string`       | `'public'`     | Default PostgreSQL schema to replicate tables from |

## Data Type Mapping

| PostgreSQL Types                                                                                       | SQLite Type |
| ------------------------------------------------------------------------------------------------------ | ----------- |
| `integer`, `bigint`, `smallint`, `serial`, `bigserial`, `boolean`, `bit`                               | `INTEGER`   |
| `numeric`, `decimal`, `real`, `double precision`, `money`                                              | `REAL`      |
| `bytea`                                                                                                | `BLOB`      |
| `text`, `varchar`, `char`, `date`, `timestamp`, `timestamptz`, `json`, `jsonb`, `uuid`, arrays (`*[]`) | `TEXT`      |
