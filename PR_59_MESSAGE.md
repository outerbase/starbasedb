## Purpose

Fixes #59 by replacing memory-heavy export behavior with streaming + async job-based dump processing that can continue beyond request limits, with optional R2 artifact storage, callback notification, and alarm-driven continuation.

Closes #59
/claim #59

## Tasks

<!-- [ ] incomplete; [x] complete -->

- [x] Implement streaming export primitives for SQL/CSV/JSON to avoid loading full tables in memory
- [x] Add async dump flow: `POST /export/dump`, `GET /export/dump/:jobId`, `GET /export/dump/:jobId/download`
- [x] Persist export job state in DO SQLite (`tmp_export_jobs`, `tmp_export_job_tables`, `tmp_export_job_chunks`)
- [x] Add DO alarm continuation for long-running export jobs
- [x] Add optional callback URL support on async dump completion/failure
- [x] Add callback retry with exponential backoff and alarm scheduling
- [x] Add optional R2 artifact support (`EXPORT_R2_BUCKET`) and stream downloads from R2 when available
- [x] Add stale export metadata cleanup logic in alarm cycle
- [x] Update docs for async dump usage and optional R2 binding
- [x] Add and update unit tests for new/changed export behavior

## Verify

<!-- guidance or steps to assist the reviewer -->

- Run tests:

```bash
pnpm vitest run \
  src/handler.test.ts \
  src/do.test.ts \
  src/export/async-dump.test.ts \
  src/export/dump.test.ts \
  src/export/csv.test.ts \
  src/export/json.test.ts \
  src/export/index.test.ts
```

- Manual sanity checks:

```bash
# Start async export
curl --location --request POST 'https://starbasedb.YOUR-ID-HERE.workers.dev/export/dump' \
  --header 'Authorization: Bearer ABC123' \
  --header 'Content-Type: application/json' \
  --data '{"callbackUrl":"https://example.com/webhooks/export-complete"}'

# Poll status
curl --location 'https://starbasedb.YOUR-ID-HERE.workers.dev/export/dump/JOB_ID_HERE' \
  --header 'Authorization: Bearer ABC123'

# Download result
curl --location 'https://starbasedb.YOUR-ID-HERE.workers.dev/export/dump/JOB_ID_HERE/download' \
  --header 'Authorization: Bearer ABC123' \
  --output database_dump.sql
```

## Before

<!-- screenshot before changes -->

Large DB dump requests could fail due to request timeout / memory-heavy accumulation.

## After

<!-- screenshot after changes -->

- Exports stream and paginate data instead of aggregating full datasets in memory.
- Long-running dump operations continue asynchronously with persisted checkpoints.
- Status/download endpoints provide retrieval after completion.
- Optional callback notifications (with retry backoff) and optional R2 artifact storage are supported.

## Demo Video

Required by bounty guidelines:

- [ADD DEMO VIDEO LINK HERE]
