import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite')
const migrationSql = readFileSync(new URL('./migration.sql', import.meta.url), {
    encoding: 'utf8',
})

let db: InstanceType<typeof DatabaseSync>

function executeMigration() {
    db.exec('PRAGMA foreign_keys = ON')
    db.exec(migrationSql)
}

function insertUser(opts: {
    username?: string | null
    email?: string | null
    password?: string
}) {
    return db
        .prepare(
            `
            INSERT INTO auth_users (username, email, password)
            VALUES (?, ?, ?)
        `
        )
        .run(opts.username ?? null, opts.email ?? null, opts.password ?? 'pw')
}

describe('auth template migration', () => {
    beforeEach(() => {
        db = new DatabaseSync(':memory:')
        executeMigration()
    })

    afterEach(() => {
        db.close()
    })

    it('creates the auth tables and can be applied more than once', () => {
        executeMigration()

        const tables = db
            .prepare(
                `
                SELECT name
                FROM sqlite_master
                WHERE type = 'table' AND name IN ('auth_users', 'auth_sessions')
                ORDER BY name
            `
            )
            .all()

        expect(tables).toEqual([
            { name: 'auth_sessions' },
            { name: 'auth_users' },
        ])
    })

    it('requires at least one identity field and permits username-only or email-only users', () => {
        insertUser({ username: 'manuel' })
        insertUser({ email: 'manuel@example.com' })

        expect(() => insertUser({})).toThrow()
    })

    it('rejects case-insensitive username, email, and cross-field identity collisions', () => {
        insertUser({ username: 'Manuel' })
        insertUser({ email: 'other@example.com' })

        expect(() => insertUser({ username: 'manuel' })).toThrow()
        expect(() => insertUser({ email: 'OTHER@example.com' })).toThrow()
        expect(() => insertUser({ email: 'MANUEL' })).toThrow()
        expect(() => insertUser({ username: 'other@example.com' })).toThrow()
    })

    it('enforces session ownership and unique session tokens', () => {
        const user = insertUser({ username: 'session-user' })

        const insertSession = db.prepare(
            `
            INSERT INTO auth_sessions (user_id, session_token)
            VALUES (?, ?)
        `
        )

        insertSession.run(user.lastInsertRowid, 'session-token')

        expect(() =>
            insertSession.run(user.lastInsertRowid, 'session-token')
        ).toThrow()
        expect(() => insertSession.run(999, 'other-token')).toThrow()
    })
})
