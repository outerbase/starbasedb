/**
 * Streaming database dump implementation.
 *
 * Designed to work around two Cloudflare constraints that the legacy
 * src/export/dump.ts cannot:
 *   1. Durable Object memory ceiling (currently 1GB, soon 10GB) — the legacy
 *      path accumulates the whole dump in a JS string before responding.
 *   2. 30-second wall-clock limit on a single Worker / DO request.
 *
 * The job runs inside the Durable Object itself: state is held in DO storage
 * so it survives invocations, dump bytes are flushed straight into an R2
 * multipart upload, and an alarm re-enters the DO to continue work whenever a
 * single tick approaches the time budget.
 *
 * Pending (sub-5MiB) bytes that haven't been flushed as a multipart part yet
 * live in a temporary R2 object — DO storage values are capped at 128 KiB, so
 * the buffer cannot live in storage directly.
 */

export type DumpFormat = 'sql' | 'csv' | 'json'

export type DumpStatus =
    | 'queued'
    | 'processing'
    | 'completed'
    | 'failed'
    | 'cancelled'

export interface DumpJobOptions {
    format: DumpFormat
    /** Optional callback URL invoked once the dump completes (success or failure). */
    callbackUrl?: string
    /** Optional single table to dump (CSV/JSON default to first table when omitted). */
    table?: string
    /** Optional chunk size override (rows per SELECT batch). Default 1000. */
    chunkSize?: number
}

export interface DumpJobProgress {
    tables: string[]
    currentTableIndex: number
    currentTable: string | null
    rowOffset: number
    rowsDumped: number
    bytesWritten: number
    partsUploaded: number
    startedAt: number
    updatedAt: number
    completedAt?: number
}

export interface DumpJobState {
    jobId: string
    status: DumpStatus
    format: DumpFormat
    callbackUrl?: string
    /** R2 object key the finished dump will be written under. */
    objectKey: string
    /** Multipart upload identifier, present while parts are being streamed. */
    uploadId?: string
    /** Completed parts of the multipart upload. */
    parts: R2UploadedPart[]
    /** R2 key for the not-yet-flushed leftover bytes, if any. */
    pendingTempKey?: string
    /** Size of the pending temp buffer (informational). */
    pendingBufferBytes: number
    /** Phase tracking — controls what runTick() does next. */
    phase: 'header' | 'schema' | 'rows' | 'finalize' | 'done' | 'error'
    /** Whether the schema for the current table has been emitted yet. */
    schemaEmitted: boolean
    /** Cached column names for the current table when streaming rows. */
    currentColumns: string[] | null
    /** Whether the JSON array for the current table has been opened. */
    jsonTableOpened: boolean
    /** Whether at least one row has been written into the current JSON array. */
    jsonRowWritten: boolean
    error?: string
    options: { chunkSize: number }
    progress: DumpJobProgress
}

/** R2 multipart minimum part size — 5 MiB per Cloudflare docs. Last part may be smaller. */
export const R2_MIN_PART_SIZE = 5 * 1024 * 1024

/** Maximum wall-clock time we spend in a single tick before yielding to the alarm. */
export const TICK_BUDGET_MS = 20_000

/** Default rows fetched per SELECT during the dump. */
export const DEFAULT_CHUNK_SIZE = 1000

/**
 * Quote a SQLite identifier (table / column name) by wrapping it in double
 * quotes and doubling any embedded double quotes. Mirrors sqlite_master's
 * own encoding rules so the produced dump round-trips through `sqlite3`.
 */
export function quoteIdent(name: string): string {
    return `"${String(name).replace(/"/g, '""')}"`
}

/** Quote a SQL string literal — single quotes are escaped by doubling. */
export function quoteString(value: string): string {
    return `'${value.replace(/'/g, "''")}'`
}

/**
 * Serialize a single JS value into a SQLite SQL literal suitable for an
 * INSERT statement. Handles NULL, numbers, strings, booleans, and bytes
 * (rendered as the x'...' BLOB literal SQLite understands).
 */
export function sqlLiteral(value: unknown): string {
    if (value === null || value === undefined) return 'NULL'
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) return 'NULL'
        return String(value)
    }
    if (typeof value === 'bigint') return value.toString()
    if (typeof value === 'boolean') return value ? '1' : '0'
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
        const bytes =
            value instanceof ArrayBuffer
                ? new Uint8Array(value)
                : new Uint8Array(
                      (value as ArrayBufferView).buffer,
                      (value as ArrayBufferView).byteOffset,
                      (value as ArrayBufferView).byteLength
                  )
        let hex = ''
        for (const b of bytes) hex += b.toString(16).padStart(2, '0')
        return `x'${hex}'`
    }
    if (typeof value === 'object') return quoteString(JSON.stringify(value))
    return quoteString(String(value))
}

/** Quote a value for inclusion in a CSV cell, following RFC 4180. */
export function csvCell(value: unknown): string {
    if (value === null || value === undefined) return ''
    if (typeof value === 'number' || typeof value === 'bigint')
        return String(value)
    if (typeof value === 'boolean') return value ? 'true' : 'false'
    const str =
        typeof value === 'object' ? JSON.stringify(value) : String(value)
    if (/[",\r\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`
    return str
}

/**
 * Build the R2 object key used to store a job's dump. Embeds the timestamp
 * and a short random suffix so concurrent jobs cannot collide on the same key.
 */
export function buildObjectKey(jobId: string, format: DumpFormat): string {
    const ext = format === 'sql' ? 'sql' : format
    const stamp = new Date()
        .toISOString()
        .replace(/[:.]/g, '-')
        .replace('T', '_')
        .replace('Z', '')
    return `dumps/dump_${stamp}_${jobId.slice(0, 8)}.${ext}`
}

/** Build the R2 key for the temporary pending-buffer object. */
export function buildPendingKey(jobId: string): string {
    return `dumps/.pending/${jobId}.tmp`
}

/**
 * Create the initial state for a freshly queued job. The caller is expected
 * to attach an R2 uploadId once the multipart upload has been created.
 */
export function newJobState(
    jobId: string,
    options: DumpJobOptions,
    tables: string[]
): DumpJobState {
    const now = Date.now()
    return {
        jobId,
        status: 'queued',
        format: options.format,
        callbackUrl: options.callbackUrl,
        objectKey: buildObjectKey(jobId, options.format),
        uploadId: undefined,
        parts: [],
        pendingTempKey: undefined,
        pendingBufferBytes: 0,
        phase: 'header',
        schemaEmitted: false,
        currentColumns: null,
        jsonTableOpened: false,
        jsonRowWritten: false,
        options: { chunkSize: options.chunkSize ?? DEFAULT_CHUNK_SIZE },
        progress: {
            tables,
            currentTableIndex: 0,
            currentTable: tables[0] ?? null,
            rowOffset: 0,
            rowsDumped: 0,
            bytesWritten: 0,
            partsUploaded: 0,
            startedAt: now,
            updatedAt: now,
        },
    }
}

/**
 * A public-facing view of the job state, suitable for serializing into a
 * status endpoint response. Strips engine internals.
 */
export interface DumpJobStatusView {
    jobId: string
    status: DumpStatus
    format: DumpFormat
    objectKey: string
    error?: string
    progress: DumpJobProgress
}

export function toStatusView(state: DumpJobState): DumpJobStatusView {
    return {
        jobId: state.jobId,
        status: state.status,
        format: state.format,
        objectKey: state.objectKey,
        error: state.error,
        progress: state.progress,
    }
}
