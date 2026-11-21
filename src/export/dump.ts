import { executeOperation } from '.'
import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { createResponse } from '../utils'

export const SQLITE_DUMP_HEADER = 'SQLite format 3\0'
export const DUMP_JOBS_TABLE = 'tmp_dump_jobs'
export const ALARM_SLOTS_TABLE = 'tmp_alarm_slots'

export const DEFAULT_CHUNK_SIZE = 500
export const DEFAULT_SYNC_TIMEOUT_MS = 20_000
export const DEFAULT_MAX_SYNC_BYTES = 16 * 1024 * 1024
export const DEFAULT_WORK_BUDGET_MS = 5_000
export const DEFAULT_BREATHING_INTERVAL_MS = 5_000
export const DEFAULT_R2_MIN_PART_SIZE_BYTES = 5 * 1024 * 1024
export const DEFAULT_WEBHOOK_TIMEOUT_MS = 10_000

export const DUMP_JOBS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ${DUMP_JOBS_TABLE} (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    r2_key TEXT NOT NULL UNIQUE,
    upload_id TEXT,
    tables_json TEXT NOT NULL,
    table_index INTEGER NOT NULL DEFAULT 0,
    row_offset INTEGER NOT NULL DEFAULT 0,
    last_rowid TEXT,
    parts_json TEXT NOT NULL DEFAULT '[]',
    pending_staging_key TEXT,
    chunk_size INTEGER NOT NULL DEFAULT ${DEFAULT_CHUNK_SIZE},
    work_budget_ms INTEGER NOT NULL DEFAULT ${DEFAULT_WORK_BUDGET_MS},
    breathing_interval_ms INTEGER NOT NULL DEFAULT ${DEFAULT_BREATHING_INTERVAL_MS},
    rows_exported INTEGER NOT NULL DEFAULT 0,
    bytes_written INTEGER NOT NULL DEFAULT 0,
    callback_url TEXT,
    callback_status TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
);`

export type DumpJobStatus =
    | 'initializing'
    | 'in_progress'
    | 'completed'
    | 'failed'

export interface DumpJobRecord {
    id: string
    status: DumpJobStatus
    r2_key: string
    upload_id: string | null
    tables_json: string
    table_index: number
    row_offset: number
    last_rowid: string | null
    parts_json: string
    pending_staging_key: string | null
    chunk_size: number
    work_budget_ms: number
    breathing_interval_ms: number
    rows_exported: number
    bytes_written: number
    callback_url: string | null
    callback_status: string | null
    error: string | null
    created_at: string
    updated_at: string
    completed_at: string | null
}

export interface DumpJobSummary {
    jobId: string
    status: DumpJobStatus
    key: string
    statusUrl: string
    downloadUrl: string
    tablesTotal: number
    tablesExported: number
    rowsExported: number
    bytesWritten: number
    callbackStatus: string | null
    error: string | null
    createdAt: string
    updatedAt: string
    completedAt: string | null
}

export interface DumpExecutionOptions {
    async?: boolean
    callbackUrl?: string
    chunkSize?: number
    syncTimeoutMs?: number
    maxSyncBytes?: number
    workBudgetMs?: number
    breathingIntervalMs?: number
    minPartSizeBytes?: number
    now?: () => number
    fetchFn?: typeof fetch
}

export type DumpSqlExecutor = (
    sql: string,
    params?: unknown[]
) => Promise<Record<string, any>[]>

interface DumpCursor {
    tableIndex: number
    rowOffset: number
    lastRowId: string | null
}

interface DumpChunk {
    sql: string
    rowsInChunk: number
    cursor: DumpCursor
}

const textEncoder = new TextEncoder()
const ROWID_ALIAS = '__sb_rid'

const INTERNAL_STARBASE_TABLES = new Set([
    DUMP_JOBS_TABLE,
    ALARM_SLOTS_TABLE,
    'tmp_cache',
    'tmp_allowlist_queries',
    'tmp_allowlist_rejections',
    'tmp_rls_policies',
    'tmp_query_log',
    'tmp_cron_tasks',
])

const SQLITE_RESERVED_KEYWORDS = new Set(
    `abort action add after all alter always analyze and as asc attach autoincrement
     before begin between by cascade case cast check collate column commit conflict
     constraint create cross current current_date current_time current_timestamp
     database default deferrable deferred delete desc detach distinct do drop each
     else end escape except exclude exclusive exists explain fail filter first
     following for foreign from full generated glob group groups having if ignore
     immediate in index indexed initially inner insert instead intersect into is
     isnull join key last left like limit match materialized natural no not nothing
     notnull null nulls of offset on or order others outer over partition plan
     pragma preceding primary query raise range recursive references regexp reindex
     release rename replace restrict returning right rollback row rows savepoint
     select set table temp temporary then ties to transaction trigger unbounded
     union unique update using vacuum values view virtual when where window with
     without`
        .trim()
        .split(/\s+/)
)

export function formatDumpFilename(date: Date = new Date()): string {
    const p = (n: number) => String(n).padStart(2, '0')
    return (
        `dump_${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
        `-${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}.sql`
    )
}

export function shouldSkipTable(tableName: string): boolean {
    return (
        !tableName ||
        tableName.startsWith('sqlite_') ||
        tableName.startsWith('_cf_') ||
        INTERNAL_STARBASE_TABLES.has(tableName)
    )
}

export function quoteSqlIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`
}

export function formatTableIdentifier(table: string): string {
    if (
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(table) &&
        !SQLITE_RESERVED_KEYWORDS.has(table.toLowerCase())
    ) {
        return table
    }
    return quoteSqlIdentifier(table)
}

function bytesToHex(bytes: Uint8Array): string {
    let hex = ''
    for (let i = 0; i < bytes.length; i++) {
        hex += bytes[i].toString(16).padStart(2, '0')
    }
    return hex.toUpperCase()
}

export function formatSqlValue(value: unknown): string {
    if (value === null || value === undefined) return 'NULL'
    if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`
    if (typeof value === 'boolean') return value ? '1' : '0'
    if (typeof value === 'number')
        return Number.isFinite(value) ? String(value) : 'NULL'
    if (typeof value === 'bigint') return value.toString()
    if (value instanceof Uint8Array) return `X'${bytesToHex(value)}'`
    if (value instanceof ArrayBuffer)
        return `X'${bytesToHex(new Uint8Array(value))}'`
    return `'${JSON.stringify(value).replace(/'/g, "''")}'`
}

export function formatInsertStatement(
    table: string,
    row: Record<string, unknown>,
    ridAlias: string = ROWID_ALIAS
): string {
    const keys = Object.keys(row).filter((k) => k !== ridAlias)
    const values = keys.map((k) => formatSqlValue(row[k]))
    // Explicit column list when any key is a JS integer-index property (preserves exact column mapping)
    const hasNumericKey = keys.some((k) => /^(0|[1-9]\d*)$/.test(k))
    const colList = hasNumericKey
        ? ` (${keys.map(quoteSqlIdentifier).join(', ')})`
        : ''
    return `INSERT INTO ${formatTableIdentifier(table)}${colList} VALUES (${values.join(', ')});\n`
}

export function validateCallbackUrl(
    rawUrl?: string | null
): string | undefined {
    if (!rawUrl || !rawUrl.trim()) return undefined
    let parsed: URL
    try {
        parsed = new URL(rawUrl.trim())
    } catch {
        throw new Error('Invalid callback_url: must be a valid HTTP(S) URL.')
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(
            'Invalid callback_url: only http:// and https:// protocols are supported.'
        )
    }
    return parsed.toString()
}

function parseRequestOptions(
    request?: Request,
    overrides?: DumpExecutionOptions
) {
    let params: URLSearchParams | undefined
    if (request?.url) {
        try {
            params = new URL(request.url).searchParams
        } catch {
            params = undefined
        }
    }

    const intOpt = (
        override: number | undefined,
        key: string,
        fallback: number,
        min: number,
        max: number
    ) => {
        if (override !== undefined) return override
        const raw = params?.get(key)
        if (!raw || !raw.trim()) return fallback
        const n = Number.parseInt(raw, 10)
        return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
    }

    return {
        async:
            overrides?.async ??
            (params?.get('async') === 'true' || params?.get('async') === '1'),
        callbackUrl: validateCallbackUrl(
            overrides?.callbackUrl ??
                params?.get('callback_url') ??
                request?.headers.get('X-Callback-Url')
        ),
        chunkSize: intOpt(
            overrides?.chunkSize,
            'chunk_size',
            DEFAULT_CHUNK_SIZE,
            1,
            10_000
        ),
        syncTimeoutMs: intOpt(
            overrides?.syncTimeoutMs,
            'sync_timeout_ms',
            DEFAULT_SYNC_TIMEOUT_MS,
            100,
            28_000
        ),
        maxSyncBytes: overrides?.maxSyncBytes ?? DEFAULT_MAX_SYNC_BYTES,
        workBudgetMs: intOpt(
            overrides?.workBudgetMs,
            'work_budget_ms',
            DEFAULT_WORK_BUDGET_MS,
            100,
            25_000
        ),
        breathingIntervalMs: intOpt(
            overrides?.breathingIntervalMs,
            'breathing_ms',
            DEFAULT_BREATHING_INTERVAL_MS,
            100,
            30_000
        ),
        minPartSizeBytes:
            overrides?.minPartSizeBytes ?? DEFAULT_R2_MIN_PART_SIZE_BYTES,
        now: overrides?.now ?? Date.now,
        fetchFn: overrides?.fetchFn ?? fetch,
    }
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
    if (chunks.length === 0) return new Uint8Array(0)
    if (chunks.length === 1) return chunks[0]
    let total = 0
    for (const c of chunks) total += c.byteLength
    const merged = new Uint8Array(total)
    let offset = 0
    for (const c of chunks) {
        merged.set(c, offset)
        offset += c.byteLength
    }
    return merged
}

/**
 * R2 Multipart writer with strict equal-sized non-final parts and crash-safe
 * versioned R2 staging (`${key}.pending.${bytesWritten}`).
 *
 * Crash-safety protocol on pause:
 *   1. `checkpointPending()` writes a NEW versioned staging key (leaving the old one intact).
 *   2. Caller commits the new staging key + SQL cursor in `tmp_dump_jobs`.
 *   3. Caller invokes `retirePreviousStaging()` to delete the superseded staging key.
 */
export class R2MultipartDumpWriter {
    private pendingChunks: Uint8Array[] = []
    private pendingByteLength = 0
    private retiredStagingKeys: string[] = []

    private constructor(
        private readonly bucket: R2Bucket,
        public readonly key: string,
        public readonly uploadId: string,
        private readonly upload: R2MultipartUpload,
        private readonly minPartSizeBytes: number,
        private uploadedParts: R2UploadedPart[],
        private totalBytesWritten: number,
        private activeStagingKey: string | null,
        initialPending?: Uint8Array
    ) {
        if (initialPending && initialPending.byteLength > 0) {
            this.pendingChunks.push(initialPending)
            this.pendingByteLength = initialPending.byteLength
        }
    }

    static async create(
        bucket: R2Bucket,
        key: string,
        minPartSizeBytes: number = DEFAULT_R2_MIN_PART_SIZE_BYTES
    ): Promise<R2MultipartDumpWriter> {
        const upload = await bucket.createMultipartUpload(key, {
            httpMetadata: {
                contentType: 'application/x-sqlite3',
                contentDisposition: `attachment; filename="${key}"`,
            },
        })
        return new R2MultipartDumpWriter(
            bucket,
            key,
            upload.uploadId,
            upload,
            minPartSizeBytes,
            [],
            0,
            null
        )
    }

    static async resume(
        bucket: R2Bucket,
        job: DumpJobRecord,
        minPartSizeBytes: number = DEFAULT_R2_MIN_PART_SIZE_BYTES
    ): Promise<R2MultipartDumpWriter> {
        if (!job.upload_id) {
            throw new Error(`Dump job ${job.id} is missing R2 upload_id`)
        }
        const upload = bucket.resumeMultipartUpload(job.r2_key, job.upload_id)
        try {
            const uploadedParts = JSON.parse(
                job.parts_json || '[]'
            ) as R2UploadedPart[]
            let initialPending: Uint8Array | undefined
            if (job.pending_staging_key) {
                const staged = await bucket.get(job.pending_staging_key)
                if (!staged) {
                    throw new Error(
                        `Missing R2 dump staging buffer: ${job.pending_staging_key}`
                    )
                }
                initialPending = new Uint8Array(await staged.arrayBuffer())
            }
            return new R2MultipartDumpWriter(
                bucket,
                job.r2_key,
                job.upload_id,
                upload,
                minPartSizeBytes,
                uploadedParts,
                Number(job.bytes_written || 0),
                job.pending_staging_key,
                initialPending
            )
        } catch (err) {
            await upload
                .abort()
                .catch((e) => console.error('Failed to abort R2 upload:', e))
            if (job.pending_staging_key) {
                await bucket
                    .delete(job.pending_staging_key)
                    .catch((e) =>
                        console.error('Failed to delete R2 staging key:', e)
                    )
            }
            throw err
        }
    }

    get bytesWritten(): number {
        return this.totalBytesWritten
    }

    get parts(): R2UploadedPart[] {
        return [...this.uploadedParts]
    }

    async append(text: string): Promise<void> {
        if (!text) return
        const bytes = textEncoder.encode(text)
        this.pendingChunks.push(bytes)
        this.pendingByteLength += bytes.byteLength
        this.totalBytesWritten += bytes.byteLength
        if (this.pendingByteLength >= this.minPartSizeBytes) {
            await this.flushExactParts()
        }
    }

    private async flushExactParts(): Promise<void> {
        if (this.pendingByteLength < this.minPartSizeBytes) return
        const buffer = concatBytes(this.pendingChunks)
        let offset = 0
        while (buffer.byteLength - offset >= this.minPartSizeBytes) {
            const partSlice = buffer.subarray(
                offset,
                offset + this.minPartSizeBytes
            )
            const uploaded = await this.upload.uploadPart(
                this.uploadedParts.length + 1,
                partSlice
            )
            this.uploadedParts.push(uploaded)
            offset += this.minPartSizeBytes
        }
        if (offset < buffer.byteLength) {
            const remainder = buffer.slice(offset)
            this.pendingChunks = [remainder]
            this.pendingByteLength = remainder.byteLength
        } else {
            this.pendingChunks = []
            this.pendingByteLength = 0
        }
    }

    /**
     * Stages any sub-part-size pending tail under a versioned R2 key without
     * overwriting or deleting the previously committed staging key.
     */
    async checkpointPending(): Promise<string | null> {
        if (this.pendingByteLength >= this.minPartSizeBytes) {
            await this.flushExactParts()
        }
        const prevKey = this.activeStagingKey
        if (this.pendingByteLength === 0) {
            if (prevKey) this.retiredStagingKeys.push(prevKey)
            this.activeStagingKey = null
            return null
        }

        const newKey = `${this.key}.pending.${this.totalBytesWritten}`
        if (newKey !== prevKey) {
            await this.bucket.put(newKey, concatBytes(this.pendingChunks))
            if (prevKey) this.retiredStagingKeys.push(prevKey)
            this.activeStagingKey = newKey
        }
        return newKey
    }

    /** Deletes superseded staging keys ONLY after the SQL checkpoint commits. */
    async retirePreviousStaging(): Promise<void> {
        const toDelete = this.retiredStagingKeys.splice(0)
        for (const key of toDelete) {
            await this.bucket
                .delete(key)
                .catch((e) =>
                    console.error('Failed to delete superseded R2 staging:', e)
                )
        }
    }

    /** Retires the active staging key along with any previously superseded staging keys. */
    async retireAllStaging(): Promise<void> {
        if (this.activeStagingKey) {
            this.retiredStagingKeys.push(this.activeStagingKey)
            this.activeStagingKey = null
        }
        await this.retirePreviousStaging()
    }

    async complete(): Promise<R2Object> {
        if (this.pendingByteLength > 0 || this.uploadedParts.length === 0) {
            const payload = concatBytes(this.pendingChunks)
            const uploaded = await this.upload.uploadPart(
                this.uploadedParts.length + 1,
                payload
            )
            this.uploadedParts.push(uploaded)
            this.pendingChunks = []
            this.pendingByteLength = 0
        }
        // Leave activeStagingKey intact until caller commits terminal 'completed' state in SQL,
        // then call `retireAllStaging()` so a failed terminal SQL write can never strand resume.
        return await this.upload.complete(this.uploadedParts)
    }

    async abort(): Promise<void> {
        await this.upload
            .abort()
            .catch((e) =>
                console.error('Failed to abort R2 multipart dump:', e)
            )
        await this.retireAllStaging()
    }
}

/**
 * Shared paginated SQL dump generator consumed by sync downloads, ReadableStream
 * fallbacks (no R2), and resumable DO alarm slices.
 *
 * Uses `CAST(_rowid_ AS TEXT)` keyset pagination on standard tables for O(N) scans,
 * exact 64-bit integer precision (> 2^53), immunity to user `rowid` shadowing and
 * concurrent-delete offset drift, falling back cleanly to `LIMIT/OFFSET` on
 * `WITHOUT ROWID` / `_rowid_`-shadowed tables or mocks without the alias column.
 * Adaptively halves page size if an RPC payload size limit is hit on wide rows.
 */
async function* dumpChunks(
    executeSql: DumpSqlExecutor,
    tables: string[],
    initialCursor: DumpCursor,
    chunkSize: number
): AsyncGenerator<DumpChunk> {
    const safeLimit = Math.max(1, Math.min(10_000, Math.trunc(chunkSize)))
    let { tableIndex, rowOffset, lastRowId } = initialCursor

    while (tableIndex < tables.length) {
        const table = tables[tableIndex]
        const quoted = quoteSqlIdentifier(table)
        const safeCommentTable = table.replace(/[\r\n]+/g, ' ')
        let prefixSql = ''
        let useKeyset = true
        let ridAlias = ROWID_ALIAS
        let currentLimit = safeLimit

        const isTableStart = rowOffset === 0 && lastRowId === null
        if (isTableStart || lastRowId !== null) {
            const schemaResult = await executeSql(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name=?;",
                [table]
            )
            if (schemaResult.length && schemaResult[0].sql) {
                const ddl = String(schemaResult[0].sql)
                    .trim()
                    .replace(/;+$/, '')
                if (isTableStart) {
                    prefixSql = `\n-- Table: ${safeCommentTable}\n${ddl};\n\n`
                }
                if (/\b(WITHOUT\s+ROWID|_rowid_)\b/i.test(ddl)) {
                    useKeyset = false
                }
                while (ddl.includes(ridAlias)) {
                    ridAlias += '_'
                }
            }
        } else {
            useKeyset = false
        }

        while (true) {
            let rows: Record<string, any>[]
            while (true) {
                const query = useKeyset
                    ? lastRowId !== null && /^-?\d+$/.test(lastRowId)
                        ? `SELECT CAST(_rowid_ AS TEXT) AS ${ridAlias}, * FROM ${quoted} WHERE _rowid_ > ${lastRowId} ORDER BY _rowid_ ASC LIMIT ${currentLimit};`
                        : `SELECT CAST(_rowid_ AS TEXT) AS ${ridAlias}, * FROM ${quoted} ORDER BY _rowid_ ASC LIMIT ${currentLimit};`
                    : `SELECT * FROM ${quoted} LIMIT ${currentLimit} OFFSET ${Math.max(0, Math.trunc(rowOffset))};`

                try {
                    rows = await executeSql(query)
                    break
                } catch (err: any) {
                    const msg = String(err?.message || '')
                    if (useKeyset && /no such column:\s*_rowid_/i.test(msg)) {
                        useKeyset = false
                        continue
                    }
                    if (
                        currentLimit > 1 &&
                        /rpc|size limit|too large|exceeded|payload/i.test(msg)
                    ) {
                        currentLimit = Math.max(1, Math.floor(currentLimit / 2))
                        continue
                    }
                    throw err
                }
            }

            let sql = prefixSql
            prefixSql = ''
            for (const row of rows) {
                sql += formatInsertStatement(table, row, ridAlias)
            }

            const hasMore = rows.length >= currentLimit
            if (hasMore) {
                if (useKeyset && ridAlias in rows[rows.length - 1]) {
                    lastRowId = String(rows[rows.length - 1][ridAlias])
                } else {
                    useKeyset = false
                    lastRowId = null
                }
                rowOffset += rows.length
            } else {
                sql += '\n'
                tableIndex += 1
                rowOffset = 0
                lastRowId = null
            }

            yield {
                sql,
                rowsInChunk: rows.length,
                cursor: { tableIndex, rowOffset, lastRowId },
            }

            if (!hasMore) break
        }
    }
}

export function toDumpJobSummary(job: DumpJobRecord): DumpJobSummary {
    let tablesTotal = 0
    try {
        const parsed = JSON.parse(job.tables_json || '[]')
        tablesTotal = Array.isArray(parsed) ? parsed.length : 0
    } catch {
        tablesTotal = 0
    }

    return {
        jobId: job.id,
        status: job.status,
        key: job.r2_key,
        statusUrl: `/export/dump/${job.id}`,
        downloadUrl: `/export/dump/${job.id}/download`,
        tablesTotal,
        tablesExported: Math.min(Number(job.table_index || 0), tablesTotal),
        rowsExported: Number(job.rows_exported || 0),
        bytesWritten: Number(job.bytes_written || 0),
        callbackStatus: job.callback_status ?? null,
        error: job.error ?? null,
        createdAt: job.created_at,
        updatedAt: job.updated_at,
        completedAt: job.completed_at ?? null,
    }
}

async function deliverCallback(
    job: DumpJobRecord,
    fetchFn: typeof fetch
): Promise<string | null> {
    if (!job.callback_url) return null
    const eventName =
        job.status === 'completed'
            ? 'export.dump.completed'
            : 'export.dump.failed'
    try {
        const response = await fetchFn(job.callback_url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Starbase-Event': eventName,
            },
            body: JSON.stringify({
                event: eventName,
                ...toDumpJobSummary(job),
            }),
            signal: AbortSignal.timeout(DEFAULT_WEBHOOK_TIMEOUT_MS),
        })
        const isOk =
            response.ok ?? (response.status >= 200 && response.status < 300)
        return isOk ? 'delivered' : `failed:${response.status}`
    } catch (err: any) {
        console.error('Failed to deliver dump callback:', err)
        return `failed:${err?.message || 'network_error'}`
    }
}

function makeDataSourceSqlExecutor(
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): DumpSqlExecutor {
    return async (sql: string, params?: unknown[]) => {
        const result = await executeOperation(
            params && params.length ? [{ sql, params }] : [{ sql }],
            dataSource,
            config
        )
        return (result ?? []) as Record<string, any>[]
    }
}

async function saveJob(
    executeSql: DumpSqlExecutor,
    job: DumpJobRecord
): Promise<void> {
    const cols = Object.keys(job) as (keyof DumpJobRecord)[]
    await executeSql(
        `INSERT OR REPLACE INTO ${DUMP_JOBS_TABLE} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')});`,
        cols.map((c) => job[c])
    )
}

/**
 * Atomically reserves a unique `r2_key` in `tmp_dump_jobs` via the `UNIQUE`
 * constraint BEFORE creating any R2 multipart upload, preventing concurrent
 * same-second dump requests from colliding on the same R2 object or staging key.
 */
async function reserveJobKey(
    executeSql: DumpSqlExecutor,
    baseJob: DumpJobRecord
): Promise<DumpJobRecord> {
    const insert = async (candidate: DumpJobRecord) => {
        const cols = Object.keys(candidate) as (keyof DumpJobRecord)[]
        await executeSql(
            `INSERT INTO ${DUMP_JOBS_TABLE} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')});`,
            cols.map((c) => candidate[c])
        )
        return candidate
    }

    try {
        return await insert(baseJob)
    } catch (err: any) {
        const msg = String(err?.message || '')
        if (!/unique/i.test(msg)) throw err
        const suffix = baseJob.id.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8)
        return await insert({
            ...baseJob,
            r2_key: baseJob.r2_key.replace(/\.sql$/i, `_${suffix}.sql`),
        })
    }
}

async function finishJob(
    executeSql: DumpSqlExecutor,
    job: DumpJobRecord,
    status: 'completed' | 'failed',
    now: () => number,
    fetchFn: typeof fetch,
    errorMessage?: string
): Promise<DumpJobRecord> {
    const ts = new Date(now()).toISOString()
    job.status = status
    job.pending_staging_key = null
    job.error = errorMessage ?? null
    job.updated_at = ts
    job.completed_at = ts

    // Commit terminal state FIRST so webhook receivers can download immediately without 409 races.
    await saveJob(executeSql, job)

    // Isolate webhook delivery & callback_status bookkeeping so a transient bookkeeping write
    // failure can NEVER invalidate an already-finalized backup or emit contradictory events.
    if (job.callback_url) {
        try {
            job.callback_status = await deliverCallback(job, fetchFn)
            job.updated_at = new Date(now()).toISOString()
            await saveJob(executeSql, job)
        } catch (bookkeepingErr) {
            console.error(
                'Failed to persist dump callback status:',
                bookkeepingErr
            )
        }
    }

    return job
}

/**
 * Executes a single time-bounded slice of an active R2 dump job inside
 * `StarbaseDBDurableObject.alarm()`. The DO alarm handler is the sole executor
 * of async dump jobs, eliminating concurrent Worker-vs-alarm part races.
 */
export async function processDumpJobSlice(params: {
    job: DumpJobRecord
    executeSql: DumpSqlExecutor
    bucket?: R2Bucket
    scheduleAlarm?: (scheduledTime: number) => Promise<void>
    minPartSizeBytes?: number
    now?: () => number
    fetchFn?: typeof fetch
}): Promise<DumpJobRecord> {
    const {
        executeSql,
        bucket,
        scheduleAlarm,
        minPartSizeBytes = DEFAULT_R2_MIN_PART_SIZE_BYTES,
        now = Date.now,
        fetchFn = fetch,
    } = params

    const job: DumpJobRecord = { ...params.job, status: 'in_progress' }
    if (!bucket) {
        return finishJob(
            executeSql,
            job,
            'failed',
            now,
            fetchFn,
            'R2 DUMP_BUCKET binding is not configured on Durable Object'
        )
    }

    const tables = JSON.parse(job.tables_json || '[]') as string[]
    const sliceStart = now()
    let writer: R2MultipartDumpWriter | undefined

    try {
        writer = await R2MultipartDumpWriter.resume(
            bucket,
            job,
            minPartSizeBytes
        )

        let pausedForBreathing = false
        let chunksInSlice = 0
        const gen = dumpChunks(
            executeSql,
            tables,
            {
                tableIndex: job.table_index,
                rowOffset: job.row_offset,
                lastRowId: job.last_rowid,
            },
            job.chunk_size
        )

        for await (const chunk of gen) {
            await writer.append(chunk.sql)
            job.rows_exported += chunk.rowsInChunk
            job.table_index = chunk.cursor.tableIndex
            job.row_offset = chunk.cursor.rowOffset
            job.last_rowid = chunk.cursor.lastRowId
            chunksInSlice++

            if (
                job.table_index < tables.length &&
                now() - sliceStart >= job.work_budget_ms
            ) {
                pausedForBreathing = true
                await gen.return(undefined)
                break
            }
        }

        if (pausedForBreathing && chunksInSlice > 0) {
            const stagingKey = await writer.checkpointPending()
            job.status = 'in_progress'
            job.parts_json = JSON.stringify(writer.parts)
            job.pending_staging_key = stagingKey
            job.bytes_written = writer.bytesWritten
            job.updated_at = new Date(now()).toISOString()

            // Crash-safe order: write new staging -> persist SQL -> retire old staging
            await saveJob(executeSql, job)
            await writer.retirePreviousStaging()

            if (scheduleAlarm) {
                await scheduleAlarm(now() + job.breathing_interval_ms)
            }
            return job
        }

        await writer.complete()
        job.parts_json = JSON.stringify(writer.parts)
        job.bytes_written = writer.bytesWritten
    } catch (error: any) {
        if (writer) {
            await writer.abort()
        }
        return finishJob(
            executeSql,
            job,
            'failed',
            now,
            fetchFn,
            error?.message || 'Database dump failed'
        )
    }

    // Commit terminal 'completed' state in SQL FIRST, then retire remaining staging keys
    const completedJob = await finishJob(
        executeSql,
        job,
        'completed',
        now,
        fetchFn
    )
    await writer.retireAllStaging()
    return completedJob
}

async function createR2DumpJob(params: {
    tables: string[]
    cursor: DumpCursor
    rowsExported: number
    initialChunks: string[]
    executeSql: DumpSqlExecutor
    bucket: R2Bucket
    scheduleAlarm: (scheduledTime: number) => Promise<void>
    alarmDelayMs: number
    opts: ReturnType<typeof parseRequestOptions>
}): Promise<DumpJobRecord> {
    const {
        tables,
        cursor,
        rowsExported,
        initialChunks,
        executeSql,
        bucket,
        scheduleAlarm,
        alarmDelayMs,
        opts,
    } = params

    const startedMs = opts.now()
    const startedIso = new Date(startedMs).toISOString()
    const reserved = await reserveJobKey(executeSql, {
        id: crypto.randomUUID(),
        status: 'initializing',
        r2_key: formatDumpFilename(new Date(startedMs)),
        upload_id: null,
        tables_json: JSON.stringify(tables),
        table_index: cursor.tableIndex,
        row_offset: cursor.rowOffset,
        last_rowid: cursor.lastRowId,
        parts_json: '[]',
        pending_staging_key: null,
        chunk_size: opts.chunkSize,
        work_budget_ms: opts.workBudgetMs,
        breathing_interval_ms: opts.breathingIntervalMs,
        rows_exported: rowsExported,
        bytes_written: 0,
        callback_url: opts.callbackUrl ?? null,
        callback_status: null,
        error: null,
        created_at: startedIso,
        updated_at: startedIso,
        completed_at: null,
    })

    let writer: R2MultipartDumpWriter | undefined
    try {
        writer = await R2MultipartDumpWriter.create(
            bucket,
            reserved.r2_key,
            opts.minPartSizeBytes
        )
        for (const chunk of initialChunks) {
            await writer.append(chunk)
        }
        const stagingKey = await writer.checkpointPending()

        const job: DumpJobRecord = {
            ...reserved,
            status: 'in_progress',
            upload_id: writer.uploadId,
            parts_json: JSON.stringify(writer.parts),
            pending_staging_key: stagingKey,
            bytes_written: writer.bytesWritten,
            updated_at: new Date(opts.now()).toISOString(),
        }

        await saveJob(executeSql, job)
        await writer.retirePreviousStaging()
        await scheduleAlarm(opts.now() + alarmDelayMs)
        return job
    } catch (error) {
        if (writer) await writer.abort()
        await executeSql(`DELETE FROM ${DUMP_JOBS_TABLE} WHERE id = ?;`, [
            reserved.id,
        ]).catch((e) => console.error('Failed to clean up failed dump job:', e))
        throw error
    }
}

async function deliverSyncCallback(
    opts: ReturnType<typeof parseRequestOptions>,
    dataSource: DataSource,
    tablesCount: number,
    rowsExported: number,
    bytesWritten: number
): Promise<void> {
    if (!opts.callbackUrl) return
    const p = opts
        .fetchFn(opts.callbackUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Starbase-Event': 'export.dump.completed',
            },
            body: JSON.stringify({
                event: 'export.dump.completed',
                status: 'completed',
                mode: 'sync',
                tablesTotal: tablesCount,
                tablesExported: tablesCount,
                rowsExported,
                bytesWritten,
                completedAt: new Date(opts.now()).toISOString(),
            }),
            signal: AbortSignal.timeout(DEFAULT_WEBHOOK_TIMEOUT_MS),
        })
        .then(() => undefined)
        .catch((err) => {
            console.error('Failed to deliver sync dump callback:', err)
        })

    if (dataSource.executionContext?.waitUntil) {
        dataSource.executionContext.waitUntil(p)
    } else {
        await p
    }
}

function createStreamingDumpResponse(
    gen: AsyncGenerator<DumpChunk>,
    firstChunk: IteratorResult<DumpChunk>,
    onComplete?: (rowsExported: number, bytesWritten: number) => Promise<void>
): Response {
    let headerSent = false
    let pendingFirst: IteratorResult<DumpChunk> | null = firstChunk
    let rowsExported = 0
    let bytesWritten = 0

    const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                if (!headerSent) {
                    headerSent = true
                    const hdr = textEncoder.encode(SQLITE_DUMP_HEADER)
                    bytesWritten += hdr.byteLength
                    controller.enqueue(hdr)
                    if (pendingFirst && !pendingFirst.done) {
                        rowsExported += pendingFirst.value.rowsInChunk
                        if (pendingFirst.value.sql) {
                            const chunkBytes = textEncoder.encode(
                                pendingFirst.value.sql
                            )
                            bytesWritten += chunkBytes.byteLength
                            controller.enqueue(chunkBytes)
                        }
                        pendingFirst = null
                        return
                    }
                    if (pendingFirst?.done) {
                        pendingFirst = null
                        if (onComplete) {
                            await onComplete(rowsExported, bytesWritten)
                        }
                        controller.close()
                        return
                    }
                }
                const next = await gen.next()
                if (next.done) {
                    if (onComplete) {
                        await onComplete(rowsExported, bytesWritten)
                    }
                    controller.close()
                } else {
                    rowsExported += next.value.rowsInChunk
                    if (next.value.sql) {
                        const chunkBytes = textEncoder.encode(next.value.sql)
                        bytesWritten += chunkBytes.byteLength
                        controller.enqueue(chunkBytes)
                    }
                }
            } catch (err) {
                controller.error(err)
            }
        },
        async cancel() {
            await gen.return(undefined)
        },
    })

    return new Response(stream, {
        headers: {
            'Content-Type': 'application/x-sqlite3',
            'Content-Disposition': 'attachment; filename="database_dump.sql"',
        },
    })
}

export async function dumpDatabaseRoute(
    dataSource: DataSource,
    config: StarbaseDBConfiguration,
    request?: Request,
    overrides?: DumpExecutionOptions
): Promise<Response> {
    let opts: ReturnType<typeof parseRequestOptions>
    try {
        opts = parseRequestOptions(request, overrides)
    } catch (err: any) {
        return createResponse(
            undefined,
            err?.message || 'Invalid export dump parameters',
            400
        )
    }

    const isAdmin = config.role === 'admin'
    if (opts.async && !isAdmin) {
        return createResponse(
            undefined,
            'Asynchronous R2 database dumps require admin role.',
            403
        )
    }

    const executeSql = makeDataSourceSqlExecutor(dataSource, config)
    const scheduleDumpAlarm = (ts: number) =>
        dataSource.rpc.scheduleDumpAlarm(ts)

    try {
        const tablesResult = await executeSql(
            "SELECT name FROM sqlite_master WHERE type='table';"
        )
        const tables = tablesResult
            .map((row: any) => String(row.name ?? ''))
            .filter((name) => !shouldSkipTable(name))

        // 1. Explicit async mode: enqueue job for DO alarm execution and return 202 immediately
        if (opts.async) {
            if (!dataSource.dumpBucket) {
                return createResponse(
                    undefined,
                    'R2 DUMP_BUCKET binding is required for asynchronous database dumps.',
                    400
                )
            }
            const job = await createR2DumpJob({
                tables,
                cursor: { tableIndex: 0, rowOffset: 0, lastRowId: null },
                rowsExported: 0,
                initialChunks: [SQLITE_DUMP_HEADER],
                executeSql,
                bucket: dataSource.dumpBucket,
                scheduleAlarm: scheduleDumpAlarm,
                alarmDelayMs: 0,
                opts,
            })
            return createResponse(toDumpJobSummary(job), undefined, 202)
        }

        // 2. Empty database fast path
        if (tables.length === 0) {
            await deliverSyncCallback(
                opts,
                dataSource,
                0,
                0,
                textEncoder.encode(SQLITE_DUMP_HEADER).byteLength
            )
            return new Response(
                new Blob([SQLITE_DUMP_HEADER], {
                    type: 'application/x-sqlite3',
                }),
                {
                    headers: {
                        'Content-Type': 'application/x-sqlite3',
                        'Content-Disposition':
                            'attachment; filename="database_dump.sql"',
                    },
                }
            )
        }

        const gen = dumpChunks(
            executeSql,
            tables,
            { tableIndex: 0, rowOffset: 0, lastRowId: null },
            opts.chunkSize
        )

        // 3. No R2 bucket OR non-admin role (preserves RLS/allowlist): stream via ReadableStream
        if (!dataSource.dumpBucket || !isAdmin) {
            const firstChunk = await gen.next()
            return createStreamingDumpResponse(
                gen,
                firstChunk,
                opts.callbackUrl
                    ? (rows, bytes) =>
                          deliverSyncCallback(
                              opts,
                              dataSource,
                              tables.length,
                              rows,
                              bytes
                          )
                    : undefined
            )
        }

        // 4. Admin + R2 bound: fast sync path with automatic promotion to R2 + DO alarm
        const startTime = opts.now()
        const syncChunks: string[] = [SQLITE_DUMP_HEADER]
        let syncBytes = textEncoder.encode(SQLITE_DUMP_HEADER).byteLength
        let rowsExported = 0
        let cursor: DumpCursor = {
            tableIndex: 0,
            rowOffset: 0,
            lastRowId: null,
        }

        const exceededSyncLimits = () =>
            opts.now() - startTime >= opts.syncTimeoutMs ||
            syncBytes >= opts.maxSyncBytes

        for await (const chunk of gen) {
            syncChunks.push(chunk.sql)
            syncBytes += textEncoder.encode(chunk.sql).byteLength
            rowsExported += chunk.rowsInChunk
            cursor = chunk.cursor

            if (exceededSyncLimits()) {
                await gen.return(undefined)
                const job = await createR2DumpJob({
                    tables,
                    cursor,
                    rowsExported,
                    initialChunks: syncChunks,
                    executeSql,
                    bucket: dataSource.dumpBucket,
                    scheduleAlarm: scheduleDumpAlarm,
                    alarmDelayMs:
                        cursor.tableIndex < tables.length
                            ? opts.breathingIntervalMs
                            : 0,
                    opts,
                })
                return createResponse(toDumpJobSummary(job), undefined, 202)
            }
        }

        await deliverSyncCallback(
            opts,
            dataSource,
            tables.length,
            rowsExported,
            syncBytes
        )
        return new Response(
            new Blob(syncChunks, { type: 'application/x-sqlite3' }),
            {
                headers: {
                    'Content-Type': 'application/x-sqlite3',
                    'Content-Disposition':
                        'attachment; filename="database_dump.sql"',
                },
            }
        )
    } catch (error: any) {
        console.error('Database Dump Error:', error)
        return createResponse(undefined, 'Failed to create database dump', 500)
    }
}

async function loadJob(
    jobId: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<DumpJobRecord | Response> {
    if (config.role !== 'admin') {
        return createResponse(
            undefined,
            'Dump job endpoints require admin role.',
            403
        )
    }
    if (!jobId || !jobId.trim()) {
        return createResponse(undefined, 'Dump job ID is required', 400)
    }
    const executeSql = makeDataSourceSqlExecutor(dataSource, config)
    const rows = await executeSql(
        `SELECT * FROM ${DUMP_JOBS_TABLE} WHERE id = ? LIMIT 1;`,
        [jobId.trim()]
    )
    if (!rows.length) {
        return createResponse(undefined, `Dump job '${jobId}' not found`, 404)
    }
    return rows[0] as DumpJobRecord
}

export async function getDumpJobStatusRoute(
    jobId: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<Response> {
    try {
        const jobOrRes = await loadJob(jobId, dataSource, config)
        if (jobOrRes instanceof Response) return jobOrRes
        return createResponse(toDumpJobSummary(jobOrRes), undefined, 200)
    } catch (error: any) {
        console.error('Dump Job Status Error:', error)
        return createResponse(
            undefined,
            'Failed to retrieve dump job status',
            500
        )
    }
}

export async function downloadDumpJobRoute(
    jobId: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<Response> {
    if (config.role !== 'admin') {
        return createResponse(
            undefined,
            'Dump job endpoints require admin role.',
            403
        )
    }
    if (!dataSource.dumpBucket) {
        return createResponse(
            undefined,
            'R2 DUMP_BUCKET binding is not configured.',
            503
        )
    }
    try {
        const jobOrRes = await loadJob(jobId, dataSource, config)
        if (jobOrRes instanceof Response) return jobOrRes
        if (jobOrRes.status !== 'completed') {
            return createResponse(
                toDumpJobSummary(jobOrRes),
                `Dump job '${jobId}' is not completed (current status: ${jobOrRes.status})`,
                409
            )
        }

        const object = await dataSource.dumpBucket.get(jobOrRes.r2_key)
        if (!object) {
            return createResponse(
                undefined,
                `Dump artifact '${jobOrRes.r2_key}' not found in R2 storage`,
                404
            )
        }

        const headers = new Headers({
            'Content-Type': 'application/x-sqlite3',
            'Content-Disposition': `attachment; filename="${jobOrRes.r2_key}"`,
        })
        if (typeof object.size === 'number') {
            headers.set('Content-Length', String(object.size))
        }
        return new Response(object.body, { headers })
    } catch (error: any) {
        console.error('Dump Job Download Error:', error)
        return createResponse(
            undefined,
            'Failed to download database dump',
            500
        )
    }
}
