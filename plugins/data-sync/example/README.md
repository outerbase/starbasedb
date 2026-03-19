# Data Sync — PostgreSQL example

## 1. Start Postgres

```bash
docker compose -f plugins/data-sync/example/docker-compose.yml up -d
```

Connection string (from host):

`postgres://postgres:postgres@127.0.0.1:5433/syncdemo`

## 2. Seed upstream schema

```bash
psql "postgres://postgres:postgres@127.0.0.1:5433/syncdemo" -c "
CREATE TABLE IF NOT EXISTS public.products (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO public.products (name) VALUES ('Widget A'), ('Widget B')
ON CONFLICT DO NOTHING;
"
```

## 3. Create matching SQLite tables (via StarbaseDB)

After `pnpm dev`, with admin token:

```bash
curl -s -X POST "http://127.0.0.1:8787/query" \
  -H "Authorization: Bearer ABC123" \
  -H "Content-Type: application/json" \
  -d "{\"sql\":\"CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY, name TEXT, updated_at TEXT)\"}"
```

## 4. Configure `wrangler.toml` (dev)

Uncomment/set external DB vars to point at `127.0.0.1:5433`, and set:

```toml
[vars]
DATA_SYNC_ENABLED = "true"
DATA_SYNC_JOBS = "[{\"externalTable\":\"public.products\",\"localTable\":\"products\",\"cursorKind\":\"timestamp\",\"cursorColumn\":\"updated_at\",\"pkColumns\":[\"id\"]}]"
```

## 5. Run sync

```bash
curl -s -X POST "http://127.0.0.1:8787/data-sync/sync-data" \
  -H "Authorization: Bearer ABC123" \
  -H "Content-Type: application/json" \
  -d "{}"
```

## 6. Verify

```bash
curl -s -X POST "http://127.0.0.1:8787/query" \
  -H "Authorization: Bearer ABC123" \
  -H "Content-Type: application/json" \
  -d "{\"sql\":\"SELECT * FROM products\"}"
```

## Integration test

```bash
set DATA_SYNC_TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:5433/syncdemo
pnpm vitest run plugins/data-sync/integration.pg.test.ts
```
