## Replication Plugin

The replication plugin pulls rows from an external data source into the internal
Durable Object SQLite database using cursor-based polling.

### Endpoints

- `POST /replication/tasks`
- `GET /replication/tasks`
- `DELETE /replication/tasks/:taskId`
- `POST /replication/tasks/:taskId/run`

### Create task payload

```json
{
    "sourceTable": "orders",
    "targetTable": "orders",
    "cursorColumn": "id",
    "intervalSeconds": 60,
    "batchSize": 500
}
```

### Notes

- `sourceTable`, `targetTable`, and `cursorColumn` must be simple SQL identifiers.
- External database bindings must be configured in `wrangler.toml`.
- Replication reads from external and writes to internal.
- Tasks are resumed through Durable Object alarms via `/replication/callback`.
