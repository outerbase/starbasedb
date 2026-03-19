## Purpose

Implements a replication plugin that pulls data from the configured external source into internal Durable Object SQLite on a schedule, enabling close-to-edge read replicas.

Closes #72
/claim #72

## Tasks

<!-- [ ] incomplete; [x] complete -->

- [x] Add new `ReplicationPlugin` with task management endpoints
- [x] Add internal replication task table (`tmp_replication_tasks`) and cursor state
- [x] Implement cursor-based pull (`cursor_column` + `cursor_value`) from external source
- [x] Implement write path into internal source with `INSERT OR REPLACE`
- [x] Support per-task interval and batch size controls
- [x] Trigger replication execution via Durable Object alarm callback route
- [x] Add replication alarm continuation in Durable Object `alarm()`
- [x] Register plugin in worker startup plugin list
- [x] Add plugin unit tests
- [x] Add plugin README usage guidance

## Verify

<!-- guidance or steps to assist the reviewer -->

- Run tests:

```bash
pnpm vitest run \
  plugins/replication/index.test.ts \
  src/do.test.ts \
  src/handler.test.ts
```

- Manual flow:

```bash
# Create replication task
curl --location --request POST 'https://starbasedb.YOUR-ID-HERE.workers.dev/replication/tasks' \
  --header 'Authorization: Bearer ABC123' \
  --header 'Content-Type: application/json' \
  --data '{
    "sourceTable":"orders",
    "targetTable":"orders",
    "cursorColumn":"id",
    "intervalSeconds":60,
    "batchSize":500
  }'

# List tasks
curl --location 'https://starbasedb.YOUR-ID-HERE.workers.dev/replication/tasks' \
  --header 'Authorization: Bearer ABC123'

# Run once manually
curl --location --request POST 'https://starbasedb.YOUR-ID-HERE.workers.dev/replication/tasks/TASK_ID/run' \
  --header 'Authorization: Bearer ABC123'

# Delete task
curl --location --request DELETE 'https://starbasedb.YOUR-ID-HERE.workers.dev/replication/tasks/TASK_ID' \
  --header 'Authorization: Bearer ABC123'
```

## Before

<!-- screenshot before changes -->

No built-in plugin mechanism to regularly pull selected external tables into internal SQLite for edge-local reads.

## After

<!-- screenshot after changes -->

Replication tasks can be configured per table with interval + cursor strategy, and are executed on schedule through DO alarms.

## Demo Video
