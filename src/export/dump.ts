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
export const MAX_INLINE_PENDING_BYTES = 64 * 1024

export const DUMP_JOBS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ${DUMP_JOBS_TABLE} (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    r2_key TEXT NOT NULL,
    upload_id TEXT,
    tables_json TEXT NOT NULL,
    table_index INTEGER NOT NULL DEFAULT 0,
    row_offset INTEGER NOT NULL DEFAULT 0,
    schema_emitted INTEGER NOT NULL DEFAULT 0,
    parts_json TEXT NOT NULL DEFAULT '[]',
    pending_buffer TEXT NOT NULL DEFAULT '',
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

export type DumpJobStatus = 'pending' | 'in_progress' | 'completed' | 'failed'

export interface DumpJobRecord {
    id: string
    status: DumpJobStatus
    r2_key: string
    upload_id: string | null
    tables_json: string
    table_index: number
    row_offset: number
    schema_emitted: number
    parts_json: string
    pending_buffer: string
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
    callbackUrl: string | null
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

const textEncoder = new TextEncoder()

export function formatDumpFilename(date: Date = new Date()): string {
    const pad = (n: number) => String(n).padStart(2, '0')
    const yyyy = date.getUTCFullYear()
    const mm = pad(date.getUTCMonth() + 1)
    const dd = pad(date.getUTCDate())
    const hh = pad(date.getUTCHours())
    const min = pad(date.getUTCMinutes())
    const ss = pad(date.getUTCSeconds())
    return `dump_${yyyy}${mm}${dd}-${hh}${min}${ss}.sql`
}

export function shouldSkipTable(tableName: string): boolean {
    return (
        !tableName ||
        tableName.startsWith('sqlite_') ||
        tableName === DUMP_JOBS_TABLE ||
        tableName === ALARM_SLOTS_TABLE
    )
}

export function quoteSqlIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`
}

export function formatTableIdentifier(table: string): string {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
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
    if (value === null || value === undefined) {
        return 'NULL'
    }
    if (typeof value === 'string') {
        return `'${value.replace(/'/g, "''")}'`
    }
    if (typeof value === 'boolean') {
        return value ? '1' : '0'
    }
    if (typeof value === 'number') {
        return Number.isFinite(value) ? String(value) : 'NULL'
    }
    if (typeof value === 'bigint') {
        return value.toString()
    }
    if (value instanceof Uint8Array) {
        return `X'${bytesToHex(value)}'`
    }
    if (value instanceof ArrayBuffer) {
        return `X'${bytesToHex(new Uint8Array(value))}'`
    }
    return `'${JSON.stringify(value).replace(/'/g, "''")}'`
}

export function formatInsertStatement(
    table: string,
    row: Record<string, unknown>
): string {
    const values = Object.values(row).map(formatSqlValue)
    return `INSERT INTO ${formatTableIdentifier(table)} VALUES (${values.join(', ')});\n`
}

export function validateCallbackUrl(
    rawUrl?: string | null
): string | undefined {
    if (!rawUrl || !rawUrl.trim()) {
        return undefined
    }
    const trimmed = rawUrl.trim()
    let parsed: URL
    try {
        parsed = new URL(trimmed)
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

function clampPositiveInt(
    raw: string | null | undefined,
    fallback: number,
    min: number,
    max: number
): number {
    if (raw === null || raw === undefined || raw.trim() === '') {
        return fallback
    }
    const parsed = Number.parseInt(raw, 10)
    if (!Number.isFinite(parsed) || Number.isNaN(parsed)) {
        return fallback
    }
    return Math.min(max, Math.max(min, parsed))
}

function parseRequestOptions(
    request?: Request,
    overrides?: DumpExecutionOptions
): Required<
    Pick<
        DumpExecutionOptions,
        | 'async'
        | 'chunkSize'
        | 'syncTimeoutMs'
        | 'maxSyncBytes'
        | 'workBudgetMs'
        | 'breathingIntervalMs'
        | 'minPartSizeBytes'
        | 'now'
        | 'fetchFn'
    >
> & { callbackUrl?: string } {
    let url: URL | undefined
    if (request?.url) {
        try {
            url = new URL(request.url)
        } catch {
            url = undefined
        }
    }

    const rawAsync =
        overrides?.async !== undefined
            ? overrides.async
            : url?.searchParams.get('async') === 'true' ||
              url?.searchParams.get('async') === '1'

    const rawCallback =
        overrides?.callbackUrl ??
        url?.searchParams.get('callback_url') ??
        request?.headers.get('X-Callback-Url') ??
        undefined

    const callbackUrl = validateCallbackUrl(rawCallback)

    return {
        async: rawAsync,
        callbackUrl,
        chunkSize:
            overrides?.chunkSize ??
            clampPositiveInt(
                url?.searchParams.get('chunk_size'),
                DEFAULT_CHUNK_SIZE,
                1,
                10_000
            ),
        syncTimeoutMs:
            overrides?.syncTimeoutMs ??
            clampPositiveInt(
                url?.searchParams.get('sync_timeout_ms'),
                DEFAULT_SYNC_TIMEOUT_MS,
                100,
                28_000
            ),
        maxSyncBytes: overrides?.maxSyncBytes ?? DEFAULT_MAX_SYNC_BYTES,
        workBudgetMs:
            overrides?.workBudgetMs ??
            clampPositiveInt(
                url?.searchParams.get('work_budget_ms'),
                DEFAULT_WORK_BUDGET_MS,
                100,
                25_000
            ),
        breathingIntervalMs:
            overrides?.breathingIntervalMs ??
            clampPositiveInt(
                url?.searchParams.get('breathing_ms'),
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
    if (chunks.length === 0) {
        return new Uint8Array(0)
    }
    if (chunks.length === 1) {
        return chunks[0]
    }
    let total = 0
    for (const chunk of chunks) {
        total += chunk.byteLength
    }
    const merged = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
        merged.set(chunk, offset)
        offset += chunk.byteLength
    }
    return merged
}

function encodeBase64(bytes: Uint8Array): string {
    if (bytes.byteLength === 0) {
        return ''
    }
    const CHUNK = 8192
    let binary = ''
    for (let i = 0; i < bytes.byteLength; i += CHUNK) {
        const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.byteLength))
        binary += String.fromCharCode(...slice)
    }
    return btoa(binary)
}

function decodeBase64(encoded: string): Uint8Array {
    if (!encoded) {
        return new Uint8Array(0)
    }
    const binary = atob(encoded)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i)
    }
    return bytes
}

export class R2MultipartDumpWriter {
    private bucket: R2Bucket
    public readonly key: string
    public readonly uploadId: string
    private upload: R2MultipartUpload
    private minPartSizeBytes: number
    private uploadedParts: R2UploadedPart[]
    private pendingChunks: Uint8Array[] = []
    private pendingByteLength = 0
    private totalBytesWritten: number
    private previousStagingKey: string | null

    private constructor(params: {
        bucket: R2Bucket
        key: string
        uploadId: string
        upload: R2MultipartUpload
        minPartSizeBytes: number
        uploadedParts: R2UploadedPart[]
        initialPending?: Uint8Array
        totalBytesWritten: number
        previousStagingKey?: string | null
    }) {
        this.bucket = params.bucket
        this.key = params.key
        this.uploadId = params.uploadId
        this.upload = params.upload
        this.minPartSizeBytes = params.minPartSizeBytes
        this.uploadedParts = [...params.uploadedParts]
        this.totalBytesWritten = params.totalBytesWritten
        this.previousStagingKey = params.previousStagingKey ?? null

        if (params.initialPending && params.initialPending.byteLength > 0) {
            this.pendingChunks.push(params.initialPending)
            this.pendingByteLength = params.initialPending.byteLength
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
        return new R2MultipartDumpWriter({
            bucket,
            key,
            uploadId: upload.uploadId,
            upload,
            minPartSizeBytes,
            uploadedParts: [],
            totalBytesWritten: 0,
        })
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
        const uploadedParts = JSON.parse(
            job.parts_json || '[]'
        ) as R2UploadedPart[]

        let initialPending = new Uint8Array(0)
        if (job.pending_staging_key) {
            const staged = await bucket.get(job.pending_staging_key)
            if (!staged) {
                throw new Error(
                    `Missing R2 dump staging buffer: ${job.pending_staging_key}`
                )
            }
            initialPending = new Uint8Array(await staged.arrayBuffer())
        } else if (job.pending_buffer) {
            initialPending = decodeBase64(job.pending_buffer)
        }

        return new R2MultipartDumpWriter({
            bucket,
            key: job.r2_key,
            uploadId: job.upload_id,
            upload,
            minPartSizeBytes,
            uploadedParts,
            initialPending,
            totalBytesWritten: Number(job.bytes_written || 0),
            previousStagingKey: job.pending_staging_key,
        })
    }

    get bytesWritten(): number {
        return this.totalBytesWritten
    }

    get parts(): R2UploadedPart[] {
        return [...this.uploadedParts]
    }

    async append(text: string): Promise<void> {
        if (!text) {
            return
        }
        const bytes = textEncoder.encode(text)
        this.pendingChunks.push(bytes)
        this.pendingByteLength += bytes.byteLength
        this.totalBytesWritten += bytes.byteLength

        if (this.pendingByteLength >= this.minPartSizeBytes) {
            await this.flushExactParts()
        }
    }

    /**
     * Slices and uploads exact `minPartSizeBytes` non-final parts to satisfy
     * Cloudflare R2's multipart invariant ("all parts except the last must
     * be the same size"), preserving any remaining tail bytes in pendingChunks.
     */
    private async flushExactParts(): Promise<void> {
        if (this.pendingByteLength < this.minPartSizeBytes) {
            return
        }
        const buffer = concatBytes(this.pendingChunks)
        let offset = 0
        while (buffer.byteLength - offset >= this.minPartSizeBytes) {
            const partSlice = buffer.subarray(
                offset,
                offset + this.minPartSizeBytes
            )
            const partNumber = this.uploadedParts.length + 1
            const uploaded = await this.upload.uploadPart(partNumber, partSlice)
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

    async checkpointPending(): Promise<{
        pendingBuffer: string
        pendingStagingKey: string | null
    }> {
        if (this.pendingByteLength >= this.minPartSizeBytes) {
            await this.flushExactParts()
        }

        if (this.pendingByteLength === 0) {
            if (this.previousStagingKey) {
                await this.bucket.delete(this.previousStagingKey)
                this.previousStagingKey = null
            }
            return { pendingBuffer: '', pendingStagingKey: null }
        }

        const payload = concatBytes(this.pendingChunks)
        if (payload.byteLength <= MAX_INLINE_PENDING_BYTES) {
            if (this.previousStagingKey) {
                await this.bucket.delete(this.previousStagingKey)
                this.previousStagingKey = null
            }
            return {
                pendingBuffer: encodeBase64(payload),
                pendingStagingKey: null,
            }
        }

        const stagingKey = `${this.key}.pending`
        await this.bucket.put(stagingKey, payload)
        this.previousStagingKey = stagingKey
        return {
            pendingBuffer: '',
            pendingStagingKey: stagingKey,
        }
    }

    async complete(): Promise<R2Object> {
        if (this.pendingByteLength > 0 || this.uploadedParts.length === 0) {
            const payload = concatBytes(this.pendingChunks)
            const partNumber = this.uploadedParts.length + 1
            const uploaded = await this.upload.uploadPart(partNumber, payload)
            this.uploadedParts.push(uploaded)
            this.pendingChunks = []
            this.pendingByteLength = 0
        }

        const completed = await this.upload.complete(this.uploadedParts)

        if (this.previousStagingKey) {
            try {
                await this.bucket.delete(this.previousStagingKey)
            } catch (cleanupErr) {
                console.error(
                    'Failed to delete R2 dump staging key:',
                    cleanupErr
                )
            }
            this.previousStagingKey = null
        }

        return completed
    }

    async abort(): Promise<void> {
        try {
            await this.upload.abort()
        } catch (err) {
            console.error('Failed to abort R2 multipart dump upload:', err)
        }
        if (this.previousStagingKey) {
            try {
                await this.bucket.delete(this.previousStagingKey)
            } catch (cleanupErr) {
                console.error(
                    'Failed to clean up R2 staging key on abort:',
                    cleanupErr
                )
            }
            this.previousStagingKey = null
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
        callbackUrl: job.callback_url ?? null,
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
    if (!job.callback_url) {
        return null
    }

    const summary = toDumpJobSummary(job)
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
                ...summary,
            }),
        })
        return response.ok ? 'delivered' : `failed:${response.status}`
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

async function ensureDumpJobsTable(executeSql: DumpSqlExecutor): Promise<void> {
    await executeSql(DUMP_JOBS_SCHEMA_SQL)
}

async function resolveUniqueDumpKey(
    executeSql: DumpSqlExecutor,
    baseKey: string,
    jobId: string
): Promise<string> {
    const existing = await executeSql(
        `SELECT id FROM ${DUMP_JOBS_TABLE} WHERE r2_key = ? LIMIT 1;`,
        [baseKey]
    )
    if (!existing.length) {
        return baseKey
    }
    const suffix = jobId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8)
    return baseKey.replace(/\.sql$/i, `_${suffix}.sql`)
}

async function persistDumpJobInsert(
    executeSql: DumpSqlExecutor,
    job: DumpJobRecord
): Promise<void> {
    await executeSql(
        `INSERT INTO ${DUMP_JOBS_TABLE} (
            id, status, r2_key, upload_id, tables_json, table_index, row_offset,
            schema_emitted, parts_json, pending_buffer, pending_staging_key,
            chunk_size, work_budget_ms, breathing_interval_ms, rows_exported,
            bytes_written, callback_url, callback_status, error,
            created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        [
            job.id,
            job.status,
            job.r2_key,
            job.upload_id,
            job.tables_json,
            job.table_index,
            job.row_offset,
            job.schema_emitted,
            job.parts_json,
            job.pending_buffer,
            job.pending_staging_key,
            job.chunk_size,
            job.work_budget_ms,
            job.breathing_interval_ms,
            job.rows_exported,
            job.bytes_written,
            job.callback_url,
            job.callback_status,
            job.error,
            job.created_at,
            job.updated_at,
            job.completed_at,
        ]
    )
}

async function persistDumpJobUpdate(
    executeSql: DumpSqlExecutor,
    job: DumpJobRecord
): Promise<void> {
    await executeSql(
        `UPDATE ${DUMP_JOBS_TABLE}
         SET status = ?,
             table_index = ?,
             row_offset = ?,
             schema_emitted = ?,
             parts_json = ?,
             pending_buffer = ?,
             pending_staging_key = ?,
             rows_exported = ?,
             bytes_written = ?,
             callback_status = ?,
             error = ?,
             updated_at = ?,
             completed_at = ?
         WHERE id = ?;`,
        [
            job.status,
            job.table_index,
            job.row_offset,
            job.schema_emitted,
            job.parts_json,
            job.pending_buffer,
            job.pending_staging_key,
            job.rows_exported,
            job.bytes_written,
            job.callback_status,
            job.error,
            job.updated_at,
            job.completed_at,
            job.id,
        ]
    )
}

/**
 * Executes a single time-bounded slice of an active R2 dump job.
 * Designed to be called both from `StarbaseDBDurableObject.alarm()` and
 * immediately upon creating an async dump job.
 *
 * Respects `job.work_budget_ms` (e.g., 5s) before yielding and scheduling
 * the next Durable Object alarm after `job.breathing_interval_ms` (e.g., 5s)
 * so queued user queries are never starved on large (1GB-10GB) databases.
 */
export async function processDumpJobSlice(params: {
    job: DumpJobRecord
    executeSql: DumpSqlExecutor
    bucket: R2Bucket
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
        let batchesProcessedInSlice = 0

        while (job.table_index < tables.length) {
            if (
                batchesProcessedInSlice > 0 &&
                now() - sliceStart >= job.work_budget_ms
            ) {
                pausedForBreathing = true
                break
            }

            const table = tables[job.table_index]

            if (!job.schema_emitted) {
                const schemaResult = await executeSql(
                    "SELECT sql FROM sqlite_master WHERE type='table' AND name=?;",
                    [table]
                )
                if (schemaResult.length && schemaResult[0].sql) {
                    const schemaSql = String(schemaResult[0].sql)
                        .trim()
                        .replace(/;+$/, '')
                    await writer.append(
                        `\n-- Table: ${table}\n${schemaSql};\n\n`
                    )
                }
                job.schema_emitted = 1
            }

            const rows = await executeSql(
                `SELECT * FROM ${quoteSqlIdentifier(table)} LIMIT ? OFFSET ?;`,
                [job.chunk_size, job.row_offset]
            )

            if (rows.length > 0) {
                let batchSql = ''
                for (const row of rows) {
                    batchSql += formatInsertStatement(table, row)
                }
                await writer.append(batchSql)
                job.rows_exported += rows.length
                job.row_offset += rows.length
            }

            batchesProcessedInSlice++

            if (rows.length < job.chunk_size) {
                await writer.append('\n')
                job.table_index += 1
                job.row_offset = 0
                job.schema_emitted = 0
            }

            if (
                job.table_index < tables.length &&
                now() - sliceStart >= job.work_budget_ms
            ) {
                pausedForBreathing = true
                break
            }
        }

        const timestampIso = new Date(now()).toISOString()

        if (pausedForBreathing && job.table_index < tables.length) {
            const { pendingBuffer, pendingStagingKey } =
                await writer.checkpointPending()
            job.status = 'in_progress'
            job.parts_json = JSON.stringify(writer.parts)
            job.pending_buffer = pendingBuffer
            job.pending_staging_key = pendingStagingKey
            job.bytes_written = writer.bytesWritten
            job.updated_at = timestampIso

            await persistDumpJobUpdate(executeSql, job)

            if (scheduleAlarm) {
                await scheduleAlarm(now() + job.breathing_interval_ms)
            }
            return job
        }

        await writer.complete()

        job.status = 'completed'
        job.parts_json = JSON.stringify(writer.parts)
        job.pending_buffer = ''
        job.pending_staging_key = null
        job.bytes_written = writer.bytesWritten
        job.updated_at = timestampIso
        job.completed_at = timestampIso

        // Persist completed status BEFORE firing callback so webhook consumers can download immediately
        await persistDumpJobUpdate(executeSql, job)

        if (job.callback_url) {
            job.callback_status = await deliverCallback(job, fetchFn)
            job.updated_at = new Date(now()).toISOString()
            await persistDumpJobUpdate(executeSql, job)
        }
        return job
    } catch (error: any) {
        if (writer) {
            await writer.abort()
        } else {
            if (job.upload_id) {
                try {
                    await bucket
                        .resumeMultipartUpload(job.r2_key, job.upload_id)
                        .abort()
                } catch (abortErr) {
                    console.error(
                        'Failed to abort R2 multipart dump upload after resume error:',
                        abortErr
                    )
                }
            }
            if (job.pending_staging_key) {
                try {
                    await bucket.delete(job.pending_staging_key)
                } catch (cleanupErr) {
                    console.error(
                        'Failed to clean up R2 staging key after resume error:',
                        cleanupErr
                    )
                }
            }
        }
        const timestampIso = new Date(now()).toISOString()
        job.status = 'failed'
        job.error = error?.message || 'Database dump failed'
        job.pending_buffer = ''
        job.pending_staging_key = null
        job.updated_at = timestampIso
        job.completed_at = timestampIso

        await persistDumpJobUpdate(executeSql, job)

        if (job.callback_url) {
            job.callback_status = await deliverCallback(job, fetchFn)
            job.updated_at = new Date(now()).toISOString()
            await persistDumpJobUpdate(executeSql, job)
        }
        return job
    }
}

async function promoteDumpToR2Job(params: {
    tables: string[]
    tableIndex: number
    rowOffset: number
    schemaEmitted: boolean
    rowsExported: number
    initialChunks: string[]
    executeSql: DumpSqlExecutor
    bucket: R2Bucket
    scheduleAlarm?: (scheduledTime: number) => Promise<void>
    chunkSize: number
    workBudgetMs: number
    breathingIntervalMs: number
    minPartSizeBytes: number
    callbackUrl?: string
    now: () => number
}): Promise<DumpJobRecord> {
    const {
        tables,
        tableIndex,
        rowOffset,
        schemaEmitted,
        rowsExported,
        initialChunks,
        executeSql,
        bucket,
        scheduleAlarm,
        chunkSize,
        workBudgetMs,
        breathingIntervalMs,
        minPartSizeBytes,
        callbackUrl,
        now,
    } = params

    await ensureDumpJobsTable(executeSql)

    const jobId = crypto.randomUUID()
    const startedMs = now()
    const startedIso = new Date(startedMs).toISOString()
    const baseKey = formatDumpFilename(new Date(startedMs))
    const r2Key = await resolveUniqueDumpKey(executeSql, baseKey, jobId)

    const writer = await R2MultipartDumpWriter.create(
        bucket,
        r2Key,
        minPartSizeBytes
    )

    try {
        for (const chunk of initialChunks) {
            await writer.append(chunk)
        }
        const { pendingBuffer, pendingStagingKey } =
            await writer.checkpointPending()

        const job: DumpJobRecord = {
            id: jobId,
            status: 'in_progress',
            r2_key: r2Key,
            upload_id: writer.uploadId,
            tables_json: JSON.stringify(tables),
            table_index: tableIndex,
            row_offset: rowOffset,
            schema_emitted: schemaEmitted ? 1 : 0,
            parts_json: JSON.stringify(writer.parts),
            pending_buffer: pendingBuffer,
            pending_staging_key: pendingStagingKey,
            chunk_size: chunkSize,
            work_budget_ms: workBudgetMs,
            breathing_interval_ms: breathingIntervalMs,
            rows_exported: rowsExported,
            bytes_written: writer.bytesWritten,
            callback_url: callbackUrl ?? null,
            callback_status: null,
            error: null,
            created_at: startedIso,
            updated_at: startedIso,
            completed_at: null,
        }

        await persistDumpJobInsert(executeSql, job)

        if (scheduleAlarm) {
            await scheduleAlarm(now() + breathingIntervalMs)
        }

        return job
    } catch (error) {
        await writer.abort()
        throw error
    }
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

    const executeSql = makeDataSourceSqlExecutor(dataSource, config)
    const scheduleAlarm = dataSource.rpc?.scheduleDumpAlarm
        ? (scheduledTime: number) =>
              dataSource.rpc.scheduleDumpAlarm(scheduledTime)
        : dataSource.rpc?.setAlarm
          ? (scheduledTime: number) => dataSource.rpc.setAlarm(scheduledTime)
          : undefined

    try {
        const tablesResult = await executeSql(
            "SELECT name FROM sqlite_master WHERE type='table';"
        )
        const tables = tablesResult
            .map((row: any) => String(row.name ?? ''))
            .filter((name) => !shouldSkipTable(name))

        // Explicit async mode: start immediately as a resumable R2 multipart dump job
        if (opts.async) {
            if (!dataSource.dumpBucket) {
                return createResponse(
                    undefined,
                    'R2 DUMP_BUCKET binding is required for asynchronous database dumps.',
                    400
                )
            }

            const initialJob = await promoteDumpToR2Job({
                tables,
                tableIndex: 0,
                rowOffset: 0,
                schemaEmitted: false,
                rowsExported: 0,
                initialChunks: [SQLITE_DUMP_HEADER],
                executeSql,
                bucket: dataSource.dumpBucket,
                chunkSize: opts.chunkSize,
                workBudgetMs: opts.workBudgetMs,
                breathingIntervalMs: opts.breathingIntervalMs,
                minPartSizeBytes: opts.minPartSizeBytes,
                callbackUrl: opts.callbackUrl,
                now: opts.now,
            })

            const updatedJob = await processDumpJobSlice({
                job: initialJob,
                executeSql,
                bucket: dataSource.dumpBucket,
                scheduleAlarm,
                minPartSizeBytes: opts.minPartSizeBytes,
                now: opts.now,
                fetchFn: opts.fetchFn,
            })

            return createResponse(toDumpJobSummary(updatedJob), undefined, 202)
        }

        // Fast synchronous path with chunked pagination and automatic R2 promotion on timeout/size limit
        const startTime = opts.now()
        const syncChunks: string[] = [SQLITE_DUMP_HEADER]
        let syncBytes = textEncoder.encode(SQLITE_DUMP_HEADER).byteLength
        let rowsExported = 0

        const pushSyncChunk = (chunk: string) => {
            syncChunks.push(chunk)
            syncBytes += textEncoder.encode(chunk).byteLength
        }

        const exceededSyncLimits = () =>
            opts.now() - startTime >= opts.syncTimeoutMs ||
            syncBytes >= opts.maxSyncBytes

        for (let tableIndex = 0; tableIndex < tables.length; tableIndex++) {
            const table = tables[tableIndex]
            let schemaEmitted = false
            let rowOffset = 0

            if (exceededSyncLimits()) {
                if (!dataSource.dumpBucket) {
                    return createResponse(
                        undefined,
                        'Database dump exceeded synchronous execution limits. Configure an R2 DUMP_BUCKET binding for large database dumps.',
                        503
                    )
                }
                const job = await promoteDumpToR2Job({
                    tables,
                    tableIndex,
                    rowOffset: 0,
                    schemaEmitted: false,
                    rowsExported,
                    initialChunks: syncChunks,
                    executeSql,
                    bucket: dataSource.dumpBucket,
                    scheduleAlarm,
                    chunkSize: opts.chunkSize,
                    workBudgetMs: opts.workBudgetMs,
                    breathingIntervalMs: opts.breathingIntervalMs,
                    minPartSizeBytes: opts.minPartSizeBytes,
                    callbackUrl: opts.callbackUrl,
                    now: opts.now,
                })
                return createResponse(toDumpJobSummary(job), undefined, 202)
            }

            const schemaResult = await executeSql(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name=?;",
                [table]
            )

            if (schemaResult.length && schemaResult[0].sql) {
                const schemaSql = String(schemaResult[0].sql)
                    .trim()
                    .replace(/;+$/, '')
                pushSyncChunk(`\n-- Table: ${table}\n${schemaSql};\n\n`)
            }
            schemaEmitted = true

            while (true) {
                if (exceededSyncLimits()) {
                    if (!dataSource.dumpBucket) {
                        return createResponse(
                            undefined,
                            'Database dump exceeded synchronous execution limits. Configure an R2 DUMP_BUCKET binding for large database dumps.',
                            503
                        )
                    }
                    const job = await promoteDumpToR2Job({
                        tables,
                        tableIndex,
                        rowOffset,
                        schemaEmitted,
                        rowsExported,
                        initialChunks: syncChunks,
                        executeSql,
                        bucket: dataSource.dumpBucket,
                        scheduleAlarm,
                        chunkSize: opts.chunkSize,
                        workBudgetMs: opts.workBudgetMs,
                        breathingIntervalMs: opts.breathingIntervalMs,
                        minPartSizeBytes: opts.minPartSizeBytes,
                        callbackUrl: opts.callbackUrl,
                        now: opts.now,
                    })
                    return createResponse(toDumpJobSummary(job), undefined, 202)
                }

                const rows = await executeSql(
                    `SELECT * FROM ${quoteSqlIdentifier(table)} LIMIT ? OFFSET ?;`,
                    [opts.chunkSize, rowOffset]
                )

                if (rows.length > 0) {
                    let batchSql = ''
                    for (const row of rows) {
                        batchSql += formatInsertStatement(table, row)
                    }
                    pushSyncChunk(batchSql)
                    rowsExported += rows.length
                    rowOffset += rows.length
                }

                if (rows.length < opts.chunkSize) {
                    pushSyncChunk('\n')
                    break
                }
            }
        }

        const blob = new Blob(syncChunks, { type: 'application/x-sqlite3' })
        const headers = new Headers({
            'Content-Type': 'application/x-sqlite3',
            'Content-Disposition': 'attachment; filename="database_dump.sql"',
        })

        if (opts.callbackUrl) {
            const completedAt = new Date(opts.now()).toISOString()
            const notifyPromise = opts
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
                        tablesTotal: tables.length,
                        tablesExported: tables.length,
                        rowsExported,
                        bytesWritten: syncBytes,
                        completedAt,
                    }),
                })
                .catch((err) => {
                    console.error('Failed to deliver sync dump callback:', err)
                })

            if (dataSource.executionContext?.waitUntil) {
                dataSource.executionContext.waitUntil(notifyPromise)
            } else {
                await notifyPromise
            }
        }

        return new Response(blob, { headers })
    } catch (error: any) {
        console.error('Database Dump Error:', error)
        return createResponse(undefined, 'Failed to create database dump', 500)
    }
}

export async function getDumpJobStatusRoute(
    jobId: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<Response> {
    if (!jobId || !jobId.trim()) {
        return createResponse(undefined, 'Dump job ID is required', 400)
    }

    const executeSql = makeDataSourceSqlExecutor(dataSource, config)
    try {
        await ensureDumpJobsTable(executeSql)
        const rows = await executeSql(
            `SELECT * FROM ${DUMP_JOBS_TABLE} WHERE id = ? LIMIT 1;`,
            [jobId.trim()]
        )
        if (!rows.length) {
            return createResponse(
                undefined,
                `Dump job '${jobId}' not found`,
                404
            )
        }
        return createResponse(
            toDumpJobSummary(rows[0] as DumpJobRecord),
            undefined,
            200
        )
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
    if (!jobId || !jobId.trim()) {
        return createResponse(undefined, 'Dump job ID is required', 400)
    }
    if (!dataSource.dumpBucket) {
        return createResponse(
            undefined,
            'R2 DUMP_BUCKET binding is not configured.',
            503
        )
    }

    const executeSql = makeDataSourceSqlExecutor(dataSource, config)
    try {
        await ensureDumpJobsTable(executeSql)
        const rows = await executeSql(
            `SELECT * FROM ${DUMP_JOBS_TABLE} WHERE id = ? LIMIT 1;`,
            [jobId.trim()]
        )
        if (!rows.length) {
            return createResponse(
                undefined,
                `Dump job '${jobId}' not found`,
                404
            )
        }

        const job = rows[0] as DumpJobRecord
        if (job.status !== 'completed') {
            return createResponse(
                toDumpJobSummary(job),
                `Dump job '${jobId}' is not completed (current status: ${job.status})`,
                409
            )
        }

        const object = await dataSource.dumpBucket.get(job.r2_key)
        if (!object) {
            return createResponse(
                undefined,
                `Dump artifact '${job.r2_key}' not found in R2 storage`,
                404
            )
        }

        const headers = new Headers({
            'Content-Type': 'application/x-sqlite3',
            'Content-Disposition': `attachment; filename="${job.r2_key}"`,
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
