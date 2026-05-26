/**
 * Engine that drives a streaming dump through one or more DO invocations.
 *
 * Pulled out of the DO class itself so the logic can be unit-tested without
 * spinning up the full Durable Object harness. The engine is stateless across
 * ticks — all progress lives in DumpJobState which is loaded/persisted by the
 * DO between invocations.
 *
 * Buffer strategy:
 *   - Within a tick, the pending bytes live in a Uint8Array in instance memory.
 *   - When the buffer reaches the R2 multipart minimum (5 MiB) it is flushed
 *     to R2 as the next part.
 *   - When a tick yields (deadline reached, work remaining), the leftover bytes
 *     are written to a temporary R2 object so the next tick can resume them.
 *   - When the job completes, the leftover bytes — however small — are flushed
 *     as the final multipart part, and the multipart upload is completed.
 */

import {
    DumpJobState,
    DEFAULT_CHUNK_SIZE,
    R2_MIN_PART_SIZE,
    TICK_BUDGET_MS,
    csvCell,
    quoteIdent,
    sqlLiteral,
} from './streaming-dump'

/**
 * Minimal cursor-like interface so the engine can be tested without depending
 * on the Cloudflare SqlStorage runtime. Returning `null` from next() signals
 * the end of the cursor; `columns` is materialized lazily.
 */
export interface RowCursor {
    columns: string[]
    next(): Record<string, unknown> | null
    close?(): void
}

/**
 * The narrow runtime contract the engine needs from its host. The DO supplies
 * a concrete implementation that reaches into ctx.storage.sql, the R2 bucket
 * binding, and DO storage for persistence.
 */
export interface DumpEngineHost {
    /** Run a SELECT and stream rows back. */
    query(sql: string, params?: unknown[]): RowCursor
    /** Persist the job state so the next tick / status read can see it. */
    saveState(state: DumpJobState): Promise<void>
    /** Upload a multipart segment and return the part metadata. */
    uploadPart(
        uploadId: string,
        key: string,
        partNumber: number,
        body: Uint8Array
    ): Promise<R2UploadedPart>
    /** Finalize the multipart upload once all parts are recorded. */
    completeUpload(
        uploadId: string,
        key: string,
        parts: R2UploadedPart[]
    ): Promise<void>
    /** Abort the multipart upload — invoked when the job fails. */
    abortUpload(uploadId: string, key: string): Promise<void>
    /** Read the pending buffer carried over from a previous tick. */
    readPending(key: string): Promise<Uint8Array | null>
    /** Persist the pending buffer for the next tick to resume from. */
    writePending(key: string, bytes: Uint8Array): Promise<void>
    /** Clear the pending buffer after final flush. */
    deletePending(key: string): Promise<void>
    /** Optional clock override for tests. */
    now?(): number
}

const encoder = new TextEncoder()

/**
 * Mutable per-tick buffer wrapper. Maintains a Uint8Array internally and
 * grows it geometrically to amortize the cost of repeated appends. Flushes a
 * multipart part to R2 whenever the buffer crosses R2_MIN_PART_SIZE.
 */
class TickBuffer {
    private buf: Uint8Array
    private len: number

    constructor(initial: Uint8Array = new Uint8Array()) {
        // Reserve a chunk slightly above the multipart threshold so we rarely
        // need to grow the backing array during a normal tick.
        const capacity = Math.max(
            R2_MIN_PART_SIZE + 64 * 1024,
            initial.byteLength
        )
        this.buf = new Uint8Array(capacity)
        this.buf.set(initial, 0)
        this.len = initial.byteLength
    }

    get length(): number {
        return this.len
    }

    /** Return the live buffer slice — caller must not retain across appends. */
    view(): Uint8Array {
        return this.buf.subarray(0, this.len)
    }

    /** Detach the current contents as an owned copy and reset the buffer. */
    drain(): Uint8Array {
        const out = new Uint8Array(this.len)
        out.set(this.buf.subarray(0, this.len))
        this.len = 0
        return out
    }

    append(bytes: Uint8Array): void {
        const needed = this.len + bytes.byteLength
        if (needed > this.buf.byteLength) {
            let cap = this.buf.byteLength * 2
            while (cap < needed) cap *= 2
            const grown = new Uint8Array(cap)
            grown.set(this.buf.subarray(0, this.len), 0)
            this.buf = grown
        }
        this.buf.set(bytes, this.len)
        this.len += bytes.byteLength
    }
}

async function maybeFlushPart(
    state: DumpJobState,
    host: DumpEngineHost,
    buffer: TickBuffer
): Promise<void> {
    if (buffer.length < R2_MIN_PART_SIZE) return
    if (!state.uploadId)
        throw new Error('maybeFlushPart called without an active upload')
    const slice = buffer.drain()
    const partNumber = state.parts.length + 1
    const part = await host.uploadPart(
        state.uploadId,
        state.objectKey,
        partNumber,
        slice
    )
    state.parts.push(part)
    state.progress.partsUploaded = state.parts.length
}

async function flushFinalPart(
    state: DumpJobState,
    host: DumpEngineHost,
    buffer: TickBuffer
): Promise<void> {
    if (!state.uploadId)
        throw new Error('flushFinalPart called without an active upload')
    if (buffer.length === 0) return
    const slice = buffer.drain()
    const partNumber = state.parts.length + 1
    const part = await host.uploadPart(
        state.uploadId,
        state.objectKey,
        partNumber,
        slice
    )
    state.parts.push(part)
    state.progress.partsUploaded = state.parts.length
}

/** Append a UTF-8 string into the running buffer and update byte counters. */
function writeStr(state: DumpJobState, buffer: TickBuffer, str: string): void {
    const bytes = encoder.encode(str)
    buffer.append(bytes)
    state.progress.bytesWritten += bytes.byteLength
}

/** Build the SQL fragment that pages through a single table in stable order. */
function pageSql(table: string, chunkSize: number, offset: number): string {
    // We rely on whatever natural order SQLite gives us — adding an ORDER BY
    // on an unindexed table would force a full sort per page, which is far
    // worse than the slightly weaker ordering guarantee. For tables with a
    // ROWID the order is stable across the dump because we hold the DO alone.
    return `SELECT * FROM ${quoteIdent(table)} LIMIT ${chunkSize} OFFSET ${offset};`
}

/**
 * Execute a single tick. Returns true when the whole dump is finished. The
 * caller is responsible for persisting state and re-arming alarms based on
 * the returned value.
 */
export async function runTick(
    state: DumpJobState,
    host: DumpEngineHost
): Promise<{ done: boolean }> {
    const now = host.now ?? Date.now
    const deadline = now() + TICK_BUDGET_MS
    state.status = 'processing'

    // Hydrate the pending buffer from R2 if a previous tick left one behind.
    const initial = state.pendingTempKey
        ? ((await host.readPending(state.pendingTempKey)) ?? new Uint8Array())
        : new Uint8Array()
    const buffer = new TickBuffer(initial)

    try {
        if (state.phase === 'header') {
            if (state.format === 'sql') {
                writeStr(
                    state,
                    buffer,
                    '-- StarbaseDB streaming dump\n' +
                        `-- Job: ${state.jobId}\n` +
                        `-- Generated: ${new Date().toISOString()}\n` +
                        'PRAGMA foreign_keys=OFF;\n' +
                        'BEGIN TRANSACTION;\n\n'
                )
            } else if (state.format === 'json') {
                writeStr(state, buffer, '{\n')
            }
            state.phase =
                state.progress.tables.length === 0 ? 'finalize' : 'schema'
            state.progress.updatedAt = now()
        }

        while (state.phase !== 'finalize' && state.phase !== 'done') {
            if (now() >= deadline) {
                return await yieldTick(state, host, buffer, now())
            }

            const idx = state.progress.currentTableIndex
            if (idx >= state.progress.tables.length) {
                state.phase = 'finalize'
                break
            }
            const table = state.progress.tables[idx]
            state.progress.currentTable = table

            if (state.phase === 'schema') {
                await emitSchema(state, host, buffer, table, idx)
                state.schemaEmitted = true
                state.phase = 'rows'
                state.currentColumns = null
                state.jsonRowWritten = false
            }

            if (state.phase === 'rows') {
                const done = emitRowBatches(
                    state,
                    host,
                    buffer,
                    table,
                    deadline,
                    now
                )
                // emitRowBatches may flush parts mid-loop. It returns when
                // either time is up (returns false) or the table is exhausted.
                if (!(await done)) {
                    return await yieldTick(state, host, buffer, now())
                }
                // Close JSON array for this table.
                if (state.format === 'json' && state.jsonTableOpened) {
                    writeStr(
                        state,
                        buffer,
                        state.jsonRowWritten ? '\n  ]' : ']'
                    )
                    state.jsonTableOpened = false
                }
                // Maybe flush after each table boundary so memory stays bounded
                // even if the next table is much larger.
                await maybeFlushPart(state, host, buffer)
            }

            // Advance to the next table.
            state.progress.currentTableIndex = idx + 1
            state.progress.rowOffset = 0
            state.schemaEmitted = false
            state.currentColumns = null
            state.jsonTableOpened = false
            state.jsonRowWritten = false
            state.phase = 'schema'
        }

        if (state.phase === 'finalize') {
            if (state.format === 'sql') {
                writeStr(state, buffer, '\nCOMMIT;\n')
            } else if (state.format === 'json') {
                writeStr(state, buffer, '\n}\n')
            }
            await flushFinalPart(state, host, buffer)
            if (state.uploadId) {
                await host.completeUpload(
                    state.uploadId,
                    state.objectKey,
                    state.parts
                )
            }
            if (state.pendingTempKey) {
                await host.deletePending(state.pendingTempKey).catch(() => {})
                state.pendingTempKey = undefined
                state.pendingBufferBytes = 0
            }
            state.phase = 'done'
            state.status = 'completed'
            state.progress.completedAt = now()
            state.progress.updatedAt = now()
            return { done: true }
        }

        state.progress.updatedAt = now()
        return { done: false }
    } catch (err) {
        state.error = err instanceof Error ? err.message : String(err)
        state.status = 'failed'
        state.phase = 'error'
        state.progress.updatedAt = now()
        if (state.uploadId) {
            await host
                .abortUpload(state.uploadId, state.objectKey)
                .catch(() => {})
        }
        if (state.pendingTempKey) {
            await host.deletePending(state.pendingTempKey).catch(() => {})
            state.pendingTempKey = undefined
            state.pendingBufferBytes = 0
        }
        throw err
    }
}

/**
 * Save the pending buffer to R2 (so the next tick can hydrate it) and update
 * progress metadata before yielding control back to the DO alarm scheduler.
 */
async function yieldTick(
    state: DumpJobState,
    host: DumpEngineHost,
    buffer: TickBuffer,
    nowMs: number
): Promise<{ done: boolean }> {
    const bytes = buffer.drain()
    if (bytes.byteLength > 0) {
        const key = state.pendingTempKey ?? `dumps/.pending/${state.jobId}.tmp`
        await host.writePending(key, bytes)
        state.pendingTempKey = key
        state.pendingBufferBytes = bytes.byteLength
    } else if (state.pendingTempKey) {
        // Buffer was flushed mid-tick; clear the stale temp object.
        await host.deletePending(state.pendingTempKey).catch(() => {})
        state.pendingTempKey = undefined
        state.pendingBufferBytes = 0
    }
    state.progress.updatedAt = nowMs
    return { done: false }
}

/**
 * Emit the schema / per-format prelude for a given table. SQL dumps mirror
 * sqlite_master entries (table + indexes + triggers + views). CSV/JSON emit
 * just a separator/header line.
 */
async function emitSchema(
    state: DumpJobState,
    host: DumpEngineHost,
    buffer: TickBuffer,
    table: string,
    tableIndex: number
): Promise<void> {
    if (state.format === 'sql') {
        const cursor = host.query(
            `SELECT type, sql FROM sqlite_master WHERE tbl_name = ? AND sql IS NOT NULL AND type IN ('table','index','trigger','view');`,
            [table]
        )
        let header = `-- Table: ${table}\n`
        const stmts: string[] = []
        try {
            while (true) {
                const row = cursor.next()
                if (!row) break
                const sql = String(row.sql ?? '').trim()
                if (!sql) continue
                stmts.push(`${sql};\n`)
            }
        } finally {
            cursor.close?.()
        }
        writeStr(state, buffer, header + stmts.join('') + '\n')
    } else if (state.format === 'csv') {
        if (tableIndex > 0) writeStr(state, buffer, '\n')
        writeStr(state, buffer, `# table: ${table}\n`)
    } else if (state.format === 'json') {
        if (tableIndex > 0) writeStr(state, buffer, ',\n')
        writeStr(state, buffer, `  ${JSON.stringify(table)}: [`)
        state.jsonTableOpened = true
        state.jsonRowWritten = false
    }
}

/**
 * Emit row chunks for a table. Each chunk is bounded by `chunkSize` rows.
 * Returns true when the table is fully drained, false if we exit early
 * because the deadline is approaching.
 */
async function emitRowBatches(
    state: DumpJobState,
    host: DumpEngineHost,
    buffer: TickBuffer,
    table: string,
    deadline: number,
    now: () => number
): Promise<boolean> {
    const chunkSize = state.options.chunkSize || DEFAULT_CHUNK_SIZE

    while (true) {
        if (now() >= deadline) return false

        const cursor = host.query(
            pageSql(table, chunkSize, state.progress.rowOffset)
        )

        if (!state.currentColumns) {
            state.currentColumns = cursor.columns
            // Emit the CSV header on the very first batch of this table.
            if (state.format === 'csv') {
                writeStr(
                    state,
                    buffer,
                    state.currentColumns.map(csvCell).join(',') + '\n'
                )
            }
        }

        let rowsThisBatch = 0
        try {
            while (true) {
                const row = cursor.next()
                if (!row) break
                emitRow(state, buffer, table, row)
                rowsThisBatch++
                state.progress.rowsDumped++
                state.progress.rowOffset++
            }
        } finally {
            cursor.close?.()
        }

        // Flush whatever crossed the 5 MiB line during this chunk.
        await maybeFlushPart(state, host, buffer)

        if (rowsThisBatch < chunkSize) {
            // Table is fully drained.
            if (state.format === 'sql') {
                writeStr(state, buffer, '\n')
            }
            return true
        }

        // Persist progress so a crash after a flush is recoverable from this
        // exact offset, then loop and continue with the next chunk.
        await host.saveState(state)
    }
}

/** Serialize a single row into the active format and append it to the buffer. */
function emitRow(
    state: DumpJobState,
    buffer: TickBuffer,
    table: string,
    row: Record<string, unknown>
): void {
    if (state.format === 'sql') {
        const cols = state.currentColumns!
        const values = cols.map((c) => sqlLiteral(row[c]))
        const colList = cols.map(quoteIdent).join(', ')
        writeStr(
            state,
            buffer,
            `INSERT INTO ${quoteIdent(table)} (${colList}) VALUES (${values.join(', ')});\n`
        )
        return
    }

    if (state.format === 'csv') {
        const cols = state.currentColumns!
        writeStr(
            state,
            buffer,
            cols.map((c) => csvCell(row[c])).join(',') + '\n'
        )
        return
    }

    if (state.format === 'json') {
        const prefix = state.jsonRowWritten ? ',\n    ' : '\n    '
        writeStr(state, buffer, prefix + JSON.stringify(row))
        state.jsonRowWritten = true
    }
}
