import { describe, expect, it } from 'vitest'
import {
    buildIncrementalSelect,
    buildSqliteUpsert,
    getNextCursor,
} from './index'

describe('DataSyncPlugin query planning', () => {
    it('builds an initial incremental select with mapped columns', () => {
        const result = buildIncrementalSelect({
            dialect: 'postgresql',
            config: {
                sourceTable: 'public.users',
                cursorColumn: 'updated_at',
                primaryKeyColumns: ['id'],
                columns: ['id', { source: 'email_address', target: 'email' }],
                batchSize: 100,
            },
        })

        expect(result).toEqual({
            sql: 'SELECT "id", "email_address" AS "email", "updated_at" FROM "public"."users" ORDER BY "updated_at" ASC LIMIT 100',
            params: [],
        })
    })

    it('adds a cursor predicate after a checkpoint', () => {
        const result = buildIncrementalSelect({
            dialect: 'mysql',
            cursorValue: '2026-05-13T00:00:00Z',
            config: {
                sourceTable: 'users',
                cursorColumn: 'updated_at',
                batchSize: 25,
            },
        })

        expect(result).toEqual({
            sql: 'SELECT * FROM `users` WHERE `updated_at` > ? ORDER BY `updated_at` ASC LIMIT 25',
            params: ['2026-05-13T00:00:00Z'],
        })
    })

    it('defaults to selecting all columns when no allowlist is configured', () => {
        const result = buildIncrementalSelect({
            dialect: 'postgresql',
            config: {
                sourceTable: 'orders',
                cursorColumn: 'id',
            },
        })

        expect(result.sql).toBe(
            'SELECT * FROM "orders" ORDER BY "id" ASC LIMIT 500'
        )
    })

    it('clamps batch size to avoid unbounded pulls', () => {
        const result = buildIncrementalSelect({
            dialect: 'postgresql',
            config: {
                sourceTable: 'events',
                cursorColumn: 'id',
                batchSize: 999999,
            },
        })

        expect(result.sql).toContain('LIMIT 5000')
    })
})

describe('DataSyncPlugin SQLite upsert planning', () => {
    it('builds an upsert for rows with primary keys', () => {
        const result = buildSqliteUpsert({
            table: 'public_users',
            primaryKeyColumns: ['id'],
            row: {
                id: 1,
                email: 'user@example.com',
                updated_at: '2026-05-13T00:00:00Z',
            },
        })

        expect(result).toEqual({
            sql: 'INSERT INTO "public_users" ("id", "email", "updated_at") VALUES (?, ?, ?) ON CONFLICT("id") DO UPDATE SET "email" = excluded."email", "updated_at" = excluded."updated_at"',
            params: [1, 'user@example.com', '2026-05-13T00:00:00Z'],
        })
    })

    it('uses plain insert when no primary key is configured', () => {
        const result = buildSqliteUpsert({
            table: 'events',
            row: { id: 1, name: 'created' },
        })

        expect(result).toEqual({
            sql: 'INSERT INTO "events" ("id", "name") VALUES (?, ?)',
            params: [1, 'created'],
        })
    })

    it('returns the last cursor from an ordered batch', () => {
        expect(
            getNextCursor(
                [
                    { id: 1, updated_at: 'a' },
                    { id: 2, updated_at: 'b' },
                ],
                'updated_at'
            )
        ).toBe('b')
    })
})

describe('DataSyncPlugin identifier safety', () => {
    it('rejects unsafe source table identifiers', () => {
        expect(() =>
            buildIncrementalSelect({
                dialect: 'postgresql',
                config: {
                    sourceTable: 'users;DROP TABLE users',
                    cursorColumn: 'id',
                },
            })
        ).toThrow('Unsafe SQL identifier')
    })

    it('rejects unsafe SQLite target identifiers', () => {
        expect(() =>
            buildSqliteUpsert({
                table: 'users;DROP',
                row: { id: 1 },
            })
        ).toThrow('Unsafe SQL identifier')
    })
})
