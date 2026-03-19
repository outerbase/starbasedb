/**
 * Integration test: requires Docker PostgreSQL.
 * Run: docker compose -f plugins/data-sync/example/docker-compose.yml up -d
 *      DATA_SYNC_TEST_PG_URL=postgres://postgres:postgres@127.0.0.1:5433/syncdemo pnpm vitest run plugins/data-sync/integration.pg.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import pg from 'pg'

const url = process.env.DATA_SYNC_TEST_PG_URL

describe.skipIf(!url)('data-sync PostgreSQL integration', () => {
    let client: pg.Client

    beforeAll(async () => {
        client = new pg.Client({ connectionString: url })
        await client.connect()
        await client.query(`
            CREATE SCHEMA IF NOT EXISTS demo;
            DROP TABLE IF EXISTS demo.products;
            CREATE TABLE demo.products (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
            );
            INSERT INTO demo.products (name) VALUES ('alpha'), ('beta');
        `)
    })

    afterAll(async () => {
        await client?.end().catch(() => {})
    })

    it('reads seeded rows', async () => {
        const r = await client.query('SELECT * FROM demo.products ORDER BY id')
        expect(r.rows.length).toBeGreaterThanOrEqual(2)
    })
})
