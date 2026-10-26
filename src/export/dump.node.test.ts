import assert from 'node:assert/strict'
import test from 'node:test'

function formatDumpTimestamp(date: Date = new Date()): string {
    const pad = (n: number) => String(n).padStart(2, '0')
    const yyyy = date.getUTCFullYear()
    const mm = pad(date.getUTCMonth() + 1)
    const dd = pad(date.getUTCDate())
    const hh = pad(date.getUTCHours())
    const min = pad(date.getUTCMinutes())
    const ss = pad(date.getUTCSeconds())
    return `dump_${yyyy}${mm}${dd}-${hh}${min}${ss}.sql`
}

function formatSqlLiteral(value: unknown): string {
    if (value === null || value === undefined) {
        return 'NULL'
    }
    if (typeof value === 'string') {
        return `'${value.replace(/'/g, "''")}'`
    }
    if (typeof value === 'boolean') {
        return value ? '1' : '0'
    }
    return String(value)
}

test('formatDumpTimestamp formats UTC date as dump_YYYYMMDD-HHMMSS.sql', () => {
    const dt = new Date('2024-01-01T17:00:00Z')
    assert.equal(formatDumpTimestamp(dt), 'dump_20240101-170000.sql')
})

test('formatSqlLiteral handles NULL, booleans, numbers, and escaped single quotes', () => {
    assert.equal(formatSqlLiteral(null), 'NULL')
    assert.equal(formatSqlLiteral(undefined), 'NULL')
    assert.equal(formatSqlLiteral(true), '1')
    assert.equal(formatSqlLiteral(false), '0')
    assert.equal(formatSqlLiteral(42.5), '42.5')
    assert.equal(formatSqlLiteral("Alice's DB"), "'Alice''s DB'")
})
