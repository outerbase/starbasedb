# Replication plugin

Pulls rows from an external Postgres or MySQL source into the StarbaseDB
Durable Object SQLite, on a configurable per-table interval. Watermarks are
persisted in `_starbase_replication_watermarks` so polling is append-only,
and every tick is recorded in `_starbase_replication_log` for observability.

## Why a pull plugin

External data lives in a primary database somewhere far from the edge. This
plugin lets a StarbaseDB instance act as a close-to-edge read replica that
can be queried alongside (or instead of) the primary. It's pull-based so it
works for any source the host can reach over TCP, no per-provider push
infrastructure required.

## Configuration

Single env var: `REPLICATION_CONFIG_JSON`. Example:

```json
[
    {
        "source": "postgres",
        "conn": "postgres://user:pass@host:5432/db",
        "intervalSeconds": 300,
        "tables": [
            {
                "name": "users",
                "watermark": "updated_at",
                "primaryKey": "id"
            },
            { "name": "events", "watermark": "id" }
        ]
    },
    {
        "source": "mysql",
        "conn": "mysql://user:pass@host:3306/db",
        "intervalSeconds": 60,
        "tables": [
            {
                "name": "audit_log",
                "watermark": "ts",
                "target": "external_audit_log"
            }
        ]
    }
]
```

Field reference:

| Field                 | Required | Notes                                                                                                |
| --------------------- | -------- | ---------------------------------------------------------------------------------------------------- |
| `source`              | yes      | `postgres`, `mysql`, or `mock` (tests only).                                                         |
| `conn`                | yes\*    | Connection string. Required for built-in adapters.                                                   |
| `intervalSeconds`     | yes      | Poll cadence for this source. Per-table cadence inherits.                                            |
| `pageSize`            | no       | Rows per round-trip (default 1000).                                                                  |
| `tables[].name`       | yes      | Source table name. Postgres accepts `schema.table` (defaults to `public`).                           |
| `tables[].watermark`  | yes      | Column compared with `>` to pull only new rows. Must be monotonically non-decreasing for that table. |
| `tables[].primaryKey` | no       | Column or array of columns. Enables `INSERT OR REPLACE` for upserts. If omitted, append-only.        |
| `tables[].target`     | no       | Override the SQLite table name. Defaults to `name`.                                                  |

## Wiring

1. Ensure `[triggers]` is enabled in `wrangler.toml` with at least the
   smallest interval you want (e.g. `crons = ["* * * * *"]`).
2. Set `REPLICATION_CONFIG_JSON` in `wrangler.toml`'s `[vars]` block (or as a
   secret).
3. Deploy. The plugin self-registers via `src/index.ts` and the
   `scheduled()` handler.

The plugin already participates in the `fetch()` plugin chain so admin
operators can:

- `POST /replication/run` — manually fire all due tables (admin token)
- `GET  /replication/status` — read current watermarks (admin token)

That is the entire HTTP surface. There is no admin CRUD API, no web UI,
and no mutable runtime config — everything else is a `SELECT` against the
two replication tables, runnable through the normal `/query` endpoint.

## Failure semantics

If pulling one table errors, the watermark is **not** advanced for that
table, the failure is recorded in `_starbase_replication_log`, and other
tables in the same tick still run. The next tick re-attempts from the prior
watermark.

## Plugging in custom adapters

Pass `adapterFactory` to the plugin constructor to ship your own adapter
(e.g. SQL Server, ClickHouse, REST). It must implement
`ReplicationAdapter` from `plugins/replication/types.ts`.
