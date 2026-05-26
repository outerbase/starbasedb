/**
 * Tests for the streaming dump engine.
 *
 * These exercise the engine against a pure-JS fake host so we can drive
 * deterministic scenarios (multiple ticks, mid-table yields, schema fan-out)
 * without touching Cloudflare runtime APIs.
 */

import { describe, expect, it } from 'vitest'
import { runTick, RowCursor, DumpEngineHost } from './dump-engine'
import {
    DumpFormat,
    DumpJobState,
    R2_MIN_PART_SIZE,
    newJobState,
} from './streaming-dump'

type Table = {
    name: string
    columns: string[]
    rows: Record<string, unknown>[]
    schemaSql?: string
}

/**
 * In-memory test harness implementing DumpEngineHost. Captures all data
 * "uploaded" to R2 so we can assert on the produced dump.
 */
class FakeHost implements DumpEngineHost {
    public parts: { partNumber: number; body: Uint8Array }[] = []
    public completed = false
    public aborted = false
    public pending = new Map<string, Uint8Array>()
    public savedStates = 0
    public clockMs = 1_000_000

    constructor(private tables: Table[]) {}

    query(sqlText: string, params?: unknown[]): RowCursor {
        const lower = sqlText.toLowerCase()
        if (lower.includes('from sqlite_master')) {
            const target = String(params?.[0] ?? '')
            const t = this.tables.find((x) => x.name === target)
            const rows = t
                ? [
                      {
                          type: 'table',
                          sql:
                              t.schemaSql ??
                              `CREATE TABLE ${t.name} (id INTEGER)`,
                      },
                  ]
                : []
            return cursorFromRows(['type', 'sql'], rows)
        }
        // SELECT * FROM "name" LIMIT N OFFSET M;
        const m = sqlText.match(
            /from\s+"([^"]+)"\s+limit\s+(\d+)\s+offset\s+(\d+)/i
        )
        if (!m) {
            return cursorFromRows([], [])
        }
        const tableName = m[1].replace(/""/g, '"')
        const limit = parseInt(m[2], 10)
        const offset = parseInt(m[3], 10)
        const t = this.tables.find((x) => x.name === tableName)
        if (!t) return cursorFromRows([], [])
        const slice = t.rows.slice(offset, offset + limit)
        return cursorFromRows(t.columns, slice)
    }

    async saveState(_state: DumpJobState): Promise<void> {
        this.savedStates++
    }

    async uploadPart(
        _uploadId: string,
        _key: string,
        partNumber: number,
        body: Uint8Array
    ): Promise<R2UploadedPart> {
        // Copy so subsequent buffer mutations don't change recorded parts.
        const copy = new Uint8Array(body.byteLength)
        copy.set(body)
        this.parts.push({ partNumber, body: copy })
        return { partNumber, etag: `etag-${partNumber}` }
    }

    async completeUpload(): Promise<void> {
        this.completed = true
    }

    async abortUpload(): Promise<void> {
        this.aborted = true
    }

    async readPending(key: string): Promise<Uint8Array | null> {
        return this.pending.get(key) ?? null
    }

    async writePending(key: string, bytes: Uint8Array): Promise<void> {
        const copy = new Uint8Array(bytes.byteLength)
        copy.set(bytes)
        this.pending.set(key, copy)
    }

    async deletePending(key: string): Promise<void> {
        this.pending.delete(key)
    }

    now = (): number => this.clockMs

    advance(ms: number): void {
        this.clockMs += ms
    }

    /** Assemble all uploaded parts into a single string for assertions. */
    fullOutput(): string {
        const sorted = [...this.parts].sort(
            (a, b) => a.partNumber - b.partNumber
        )
        const total = sorted.reduce((n, p) => n + p.body.byteLength, 0)
        const merged = new Uint8Array(total)
        let off = 0
        for (const p of sorted) {
            merged.set(p.body, off)
            off += p.body.byteLength
        }
        return new TextDecoder().decode(merged)
    }
}

function cursorFromRows(
    columns: string[],
    rows: Record<string, unknown>[]
): RowCursor {
    let i = 0
    return {
        columns,
        next() {
            if (i >= rows.length) return null
            return rows[i++]
        },
    }
}

function makeState(
    format: DumpFormat,
    tables: string[],
    overrides: Partial<DumpJobState> = {}
): DumpJobState {
    const state = newJobState('test-job-id', { format }, tables)
    state.uploadId = 'upload-1'
    Object.assign(state, overrides)
    return state
}

describe('streaming dump engine', () => {
    it('emits a SQL dump with schema and INSERT statements in one tick', async () => {
        const host = new FakeHost([
            {
                name: 'users',
                columns: ['id', 'name'],
                rows: [
                    { id: 1, name: 'Alice' },
                    { id: 2, name: "O'Brien" },
                ],
                schemaSql: 'CREATE TABLE users (id INTEGER, name TEXT)',
            },
            {
                name: 'orders',
                columns: ['id', 'total'],
                rows: [{ id: 7, total: 99.5 }],
                schemaSql: 'CREATE TABLE orders (id INTEGER, total REAL)',
            },
        ])
        const state = makeState('sql', ['users', 'orders'])
        const { done } = await runTick(state, host)

        expect(done).toBe(true)
        expect(host.completed).toBe(true)
        expect(state.status).toBe('completed')
        const out = host.fullOutput()
        expect(out).toContain('CREATE TABLE users (id INTEGER, name TEXT);')
        expect(out).toContain(
            'INSERT INTO "users" ("id", "name") VALUES (1, \'Alice\');'
        )
        expect(out).toContain(
            'INSERT INTO "users" ("id", "name") VALUES (2, \'O\'\'Brien\');'
        )
        expect(out).toContain('CREATE TABLE orders (id INTEGER, total REAL);')
        expect(out).toContain(
            'INSERT INTO "orders" ("id", "total") VALUES (7, 99.5);'
        )
        expect(out).toContain('COMMIT;')
    })

    it('emits a CSV dump with per-table headers', async () => {
        const host = new FakeHost([
            {
                name: 'users',
                columns: ['id', 'name'],
                rows: [
                    { id: 1, name: 'Alice' },
                    { id: 2, name: 'comma, name' },
                ],
            },
        ])
        const state = makeState('csv', ['users'])
        await runTick(state, host)

        const out = host.fullOutput()
        expect(out).toContain('# table: users')
        expect(out).toContain('id,name')
        expect(out).toContain('1,Alice')
        expect(out).toContain('2,"comma, name"')
    })

    it('emits a JSON dump as a tables-keyed object', async () => {
        const host = new FakeHost([
            {
                name: 'users',
                columns: ['id', 'name'],
                rows: [
                    { id: 1, name: 'Alice' },
                    { id: 2, name: 'Bob' },
                ],
            },
        ])
        const state = makeState('json', ['users'])
        await runTick(state, host)

        const text = host.fullOutput().trim()
        const parsed = JSON.parse(text)
        expect(parsed.users).toEqual([
            { id: 1, name: 'Alice' },
            { id: 2, name: 'Bob' },
        ])
    })

    it('handles empty databases by writing only the wrapper', async () => {
        const host = new FakeHost([])
        const state = makeState('sql', [])
        const { done } = await runTick(state, host)
        expect(done).toBe(true)
        const out = host.fullOutput()
        expect(out).toContain('PRAGMA foreign_keys=OFF;')
        expect(out).toContain('COMMIT;')
        expect(out).not.toContain('INSERT INTO')
    })

    it('handles tables with zero rows by still emitting CSV headers', async () => {
        const host = new FakeHost([
            { name: 'empty', columns: ['id', 'name'], rows: [] },
        ])
        const state = makeState('csv', ['empty'])
        await runTick(state, host)
        const out = host.fullOutput()
        expect(out).toContain('# table: empty')
        expect(out).toContain('id,name')
    })

    it('yields when the time budget is hit and resumes on the next tick', async () => {
        // 25 rows, chunkSize=5. The host's `now` jumps past the deadline after
        // a couple of chunks worth of timestamp reads so the first tick yields
        // before draining the table.
        const rows = Array.from({ length: 25 }, (_, i) => ({ id: i + 1 }))
        const host = new FakeHost([
            {
                name: 'big',
                columns: ['id'],
                rows,
                schemaSql: 'CREATE TABLE big (id INTEGER)',
            },
        ])
        const baseClock = host.clockMs
        let callCount = 0
        host.now = () => {
            callCount++
            // Let several calls through at baseClock so the engine can emit a
            // couple of chunks before we fast-forward past the deadline. The
            // engine checks `now()` once per outer loop and once per row batch,
            // so we need to let ~6 calls return baseClock before jumping.
            if (callCount <= 6) return baseClock
            return baseClock + 25_000
        }
        const state = makeState('sql', ['big'])
        state.options.chunkSize = 5
        const first = await runTick(state, host)
        expect(first.done).toBe(false)
        const rowsBeforeResume = state.progress.rowsDumped
        expect(rowsBeforeResume).toBeGreaterThan(0)
        expect(rowsBeforeResume).toBeLessThan(25)

        // Resume with a stable clock — second tick should finish the job.
        host.now = () => host.clockMs
        const second = await runTick(state, host)
        expect(second.done).toBe(true)
        expect(state.status).toBe('completed')
        expect(state.progress.rowsDumped).toBe(25)
        const out = host.fullOutput()
        for (let i = 1; i <= 25; i++) {
            expect(out).toContain(`VALUES (${i});`)
        }
    })

    it('flushes multipart parts when the buffer crosses 5 MiB', async () => {
        // Produce one row whose string value alone is ~2 MiB so we cross the
        // 5 MiB part threshold quickly with only a handful of rows.
        const big = 'x'.repeat(2 * 1024 * 1024)
        const rows = Array.from({ length: 4 }, (_, i) => ({
            id: i + 1,
            payload: big,
        }))
        const host = new FakeHost([
            {
                name: 'fat',
                columns: ['id', 'payload'],
                rows,
            },
        ])
        const state = makeState('sql', ['fat'])
        await runTick(state, host)
        // We should have flushed at least one full part and the final part.
        const totalBytes = host.parts.reduce((n, p) => n + p.body.byteLength, 0)
        expect(host.parts.length).toBeGreaterThanOrEqual(2)
        expect(totalBytes).toBeGreaterThan(R2_MIN_PART_SIZE)
        expect(host.completed).toBe(true)
    })

    it('marks the job failed and aborts the upload on engine error', async () => {
        const host = new FakeHost([
            {
                name: 'broken',
                columns: ['id'],
                rows: [{ id: 1 }],
            },
        ])
        // Force completeUpload to fail so we exercise the error path.
        host.completeUpload = async () => {
            throw new Error('boom')
        }
        const state = makeState('sql', ['broken'])
        await expect(runTick(state, host)).rejects.toThrow('boom')
        expect(state.status).toBe('failed')
        expect(state.error).toBe('boom')
        expect(host.aborted).toBe(true)
    })

    it("emits BLOB values as x'...' literals in SQL dumps", async () => {
        const blob = new Uint8Array([0xde, 0xad, 0xbe, 0xef])
        const host = new FakeHost([
            {
                name: 'bin',
                columns: ['id', 'data'],
                rows: [{ id: 1, data: blob }],
            },
        ])
        const state = makeState('sql', ['bin'])
        await runTick(state, host)
        const out = host.fullOutput()
        expect(out).toContain("x'deadbeef'")
    })
})
