import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const require = createRequire(import.meta.url)
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite')
const migrationSql = readFileSync(
    new URL('./migration.sql', import.meta.url),
    'utf8'
)

let db: InstanceType<typeof DatabaseSync>

function insertUser(values: {
    username?: string | null
    email?: string | null
    password?: string
}) {
    return db
        .prepare(
            `INSERT INTO auth_users (username, email, password)
             VALUES (?, ?, ?)`
        )
        .run(
            values.username ?? null,
            values.email ?? null,
            values.password ?? 'hashed-password'
        )
}

beforeEach(() => {
    db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys = ON')
    db.exec(migrationSql)
})

afterEach(() => {
    db.close()
})

describe('auth template migration', () => {
    it('creates the auth users and sessions tables', () => {
        const tables = db
            .prepare(
                `SELECT name FROM sqlite_master
                 WHERE type = 'table' AND name IN ('auth_users', 'auth_sessions')
                 ORDER BY name`
            )
            .all()
            .map((row) => (row as { name: string }).name)

        expect(tables).toEqual(['auth_sessions', 'auth_users'])
    })

    it('requires at least one username or email for auth users', () => {
        insertUser({ username: 'kevin' })
        insertUser({ email: 'kevin@example.com' })
        insertUser({ username: 'kp', email: 'kp@example.com' })

        expect(() => insertUser({})).toThrow()
    })

    it('enforces case-insensitive username and email uniqueness', () => {
        insertUser({ username: 'KPassito', email: 'kevin@example.com' })

        expect(() => insertUser({ username: 'kpassito' })).toThrow()
        expect(() => insertUser({ email: 'KEVIN@example.com' })).toThrow()
    })

    it('prevents username and email values from overlapping across accounts', () => {
        insertUser({ username: 'kevin' })
        insertUser({ email: 'other@example.com' })

        expect(() => insertUser({ email: 'KEVIN' })).toThrow(
            /Username or email already exists/
        )
        expect(() => insertUser({ username: 'OTHER@example.com' })).toThrow(
            /Username or email already exists/
        )
    })

    it('enforces session ownership and unique session tokens', () => {
        const user = insertUser({ username: 'kevin' })

        db.prepare(
            `INSERT INTO auth_sessions (user_id, session_token)
             VALUES (?, ?)`
        ).run(user.lastInsertRowid, 'session-token')

        expect(() =>
            db
                .prepare(
                    `INSERT INTO auth_sessions (user_id, session_token)
                     VALUES (?, ?)`
                )
                .run(user.lastInsertRowid, 'session-token')
        ).toThrow()

        expect(() =>
            db
                .prepare(
                    `INSERT INTO auth_sessions (user_id, session_token)
                     VALUES (?, ?)`
                )
                .run(999, 'missing-user')
        ).toThrow()
    })
})
