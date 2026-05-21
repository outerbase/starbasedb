import { executeOperation } from '.'
import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { createResponse } from '../utils'

export interface ExportState {
    exportId: string
    status: 'pending' | 'running' | 'completed' | 'failed'
    r2Key: string
    tables: string[]
    currentTableIndex: number
    currentOffset: number
    callbackUrl?: string
    startedAt: number
    completedAt?: number
    error?: string
    // Multipart upload fields
    uploadId?: string
    partNumber: number
    parts: { partNumber: number; etag: string }[]
    // Buffer for accumulating chunks before flushing as a part
    pendingChunk: string
}

const BATCH_SIZE = 1000
// Flush a multipart part when the pending chunk buffer exceeds 5 MB
// (R2 minimum part size is 5 MiB for all parts except the last)
const MIN_PART_SIZE = 5 * 1024 * 1024
// Safety threshold: if elapsed time exceeds this, save state and set alarm
const TIMEOUT_THRESHOLD_MS = 25_000

function generateExportId(): string {
    return crypto.randomUUID()
}

function generateR2Key(): string {
    const now = new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const datePart = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    const timePart = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    return `dump_${datePart}-${timePart}.sql`
}

function escapeValue(value: unknown): string {
    if (value === null || value === undefined) return 'NULL'
    if (typeof value === 'number') return String(value)
    if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`
    // Booleans stored as integers in SQLite
    if (typeof value === 'boolean') return value ? '1' : '0'
    return `'${String(value).replace(/'/g, "''")}'`
}

function buildInsertStatement(table: string, row: Record<string, unknown>): string {
    const values = Object.values(row).map(escapeValue)
    return `INSERT INTO ${table} VALUES (${values.join(', ')});\n`
}

/**
 * Starts or resumes a streaming database export.
 *
 * Flow:
 *   1. Allocate an exportId and R2 key, persist initial state in DO storage.
 *   2. Begin a multipart upload on R2.
 *   3. Iterate tables / rows in batches; accumulate SQL text in a buffer.
 *   4. Flush the buffer as an R2 multipart part whenever it reaches MIN_PART_SIZE.
 *   5. If we approach the 30 s Worker timeout, save state and set a DO alarm to
 *      continue; return 202 Accepted with the exportId.
 *   6. On completion, finalise the multipart upload, optionally POST the callback
 *      URL, and return the file directly if the whole operation finished within the
 *      request lifetime (< TIMEOUT_THRESHOLD_MS elapsed).
 */
export async function startStreamingDump(opts: {
    dataSource: DataSource
    config: StarbaseDBConfiguration
    r2Bucket: R2Bucket
    callbackUrl?: string
    /** If provided we are resuming a previously interrupted export */
    resumeExportId?: string
}): Promise<Response> {
    const { dataSource, config, r2Bucket, callbackUrl, resumeExportId } = opts

    const startTime = Date.now()

    // ── Load or create export state ───────────────────────────────────────────
    let state: ExportState

    if (resumeExportId) {
        const stored = await dataSource.rpc.executeQuery({
            sql: `SELECT value FROM tmp_export_state WHERE export_id = ?;`,
            params: [resumeExportId],
        }) as unknown as { value: string }[]

        if (!stored.length) {
            return createResponse(undefined, `Export '${resumeExportId}' not found`, 404)
        }

        state = JSON.parse(stored[0].value) as ExportState
        if (state.status === 'completed' || state.status === 'failed') {
            return createResponse(
                { exportId: state.exportId, status: state.status },
                undefined,
                200
            )
        }
        state.status = 'running'
    } else {
        // Ensure the state table exists
        await dataSource.rpc.executeQuery({
            sql: `CREATE TABLE IF NOT EXISTS tmp_export_state (
                export_id TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );`,
        })

        // Fetch all table names upfront so we can track progress
        const tablesResult = await executeOperation(
            [{ sql: `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'tmp_%';` }],
            dataSource,
            config
        )
        const tables = (tablesResult as { name: string }[]).map((r) => r.name)

        const exportId = generateExportId()
        const r2Key = generateR2Key()

        state = {
            exportId,
            status: 'running',
            r2Key,
            tables,
            currentTableIndex: 0,
            currentOffset: 0,
            callbackUrl,
            startedAt: startTime,
            partNumber: 1,
            parts: [],
            pendingChunk: '',
        }

        // Initiate multipart upload
        const multipart = await r2Bucket.createMultipartUpload(r2Key, {
            httpMetadata: { contentType: 'application/sql' },
        })
        state.uploadId = multipart.uploadId

        await persistState(dataSource, state)
    }

    // ── Resume multipart upload handle ────────────────────────────────────────
    if (!state.uploadId) {
        return createResponse(undefined, 'Missing multipart upload ID in export state', 500)
    }

    const multipart = r2Bucket.resumeMultipartUpload(state.r2Key, state.uploadId)

    // ── Export loop ───────────────────────────────────────────────────────────
    try {
        for (
            let ti = state.currentTableIndex;
            ti < state.tables.length;
            ti++
        ) {
            const table = state.tables[ti]
            state.currentTableIndex = ti

            // Write the schema DDL only at the beginning of each table (offset === 0)
            if (state.currentOffset === 0) {
                const schemaResult = await executeOperation(
                    [
                        {
                            sql: `SELECT sql FROM sqlite_master WHERE type='table' AND name=?;`,
                            params: [table],
                        },
                    ],
                    dataSource,
                    config
                )

                if (schemaResult.length && (schemaResult[0] as { sql: string }).sql) {
                    const schemaSql = (schemaResult[0] as { sql: string }).sql
                    state.pendingChunk += `\n-- Table: ${table}\n${schemaSql};\n\n`
                }
            }

            // Paginate through rows
            let offset = state.currentOffset
            let hasMore = true

            while (hasMore) {
                // Timeout guard
                if (Date.now() - startTime >= TIMEOUT_THRESHOLD_MS) {
                    state.currentOffset = offset
                    state.status = 'running'
                    await persistState(dataSource, state)
                    // Schedule continuation via DO alarm (5 seconds from now)
                    await dataSource.rpc.setAlarm(Date.now() + 5_000)
                    return createResponse(
                        {
                            exportId: state.exportId,
                            status: 'running',
                            message: 'Export is continuing in the background',
                        },
                        undefined,
                        202
                    )
                }

                const rows = await executeOperation(
                    [
                        {
                            sql: `SELECT * FROM ${table} LIMIT ? OFFSET ?;`,
                            params: [BATCH_SIZE, offset],
                        },
                    ],
                    dataSource,
                    config
                ) as Record<string, unknown>[]

                for (const row of rows) {
                    state.pendingChunk += buildInsertStatement(table, row)
                }

                // Flush to R2 if buffer is large enough
                if (state.pendingChunk.length >= MIN_PART_SIZE) {
                    const encoder = new TextEncoder()
                    const partBytes = encoder.encode(state.pendingChunk)
                    const uploadedPart = await multipart.uploadPart(
                        state.partNumber,
                        partBytes
                    )
                    state.parts.push({ partNumber: state.partNumber, etag: uploadedPart.etag })
                    state.partNumber++
                    state.pendingChunk = ''
                    await persistState(dataSource, state)
                }

                if (rows.length < BATCH_SIZE) {
                    hasMore = false
                } else {
                    offset += BATCH_SIZE
                }
            }

            // Add trailing newline between tables
            state.pendingChunk += '\n'
            // Reset offset for the next table
            state.currentOffset = 0
        }

        // ── Flush remaining buffer as final part ──────────────────────────────
        if (state.pendingChunk.length > 0) {
            const encoder = new TextEncoder()
            const partBytes = encoder.encode(state.pendingChunk)
            const uploadedPart = await multipart.uploadPart(
                state.partNumber,
                partBytes
            )
            state.parts.push({ partNumber: state.partNumber, etag: uploadedPart.etag })
            state.partNumber++
            state.pendingChunk = ''
        }

        // ── Complete multipart upload ─────────────────────────────────────────
        await multipart.complete(state.parts)

        state.status = 'completed'
        state.completedAt = Date.now()
        await persistState(dataSource, state)

        // ── Callback notification ─────────────────────────────────────────────
        if (state.callbackUrl) {
            try {
                await fetch(state.callbackUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        exportId: state.exportId,
                        status: 'completed',
                        r2Key: state.r2Key,
                    }),
                })
            } catch (callbackErr) {
                console.error('Export callback failed:', callbackErr)
            }
        }

        // ── If we finished fast enough, stream the file back directly ─────────
        const elapsed = Date.now() - startTime
        if (elapsed < TIMEOUT_THRESHOLD_MS) {
            const object = await r2Bucket.get(state.r2Key)
            if (object) {
                return new Response(object.body, {
                    headers: {
                        'Content-Type': 'application/sql',
                        'Content-Disposition': `attachment; filename="${state.r2Key}"`,
                    },
                })
            }
        }

        return createResponse(
            {
                exportId: state.exportId,
                status: 'completed',
                r2Key: state.r2Key,
            },
            undefined,
            200
        )
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        console.error('Streaming dump error:', error)
        state.status = 'failed'
        state.error = message
        await persistState(dataSource, state)

        // Attempt to abort the multipart upload to clean up R2 storage
        try {
            await multipart.abort()
        } catch (_) {
            // best-effort
        }

        return createResponse(undefined, `Export failed: ${message}`, 500)
    }
}

/**
 * Returns the current status of an export job.
 */
export async function getExportStatus(opts: {
    dataSource: DataSource
    exportId: string
}): Promise<Response> {
    const { dataSource, exportId } = opts

    const stored = await dataSource.rpc.executeQuery({
        sql: `SELECT value FROM tmp_export_state WHERE export_id = ?;`,
        params: [exportId],
    }) as unknown as { value: string }[]

    if (!stored.length) {
        return createResponse(undefined, `Export '${exportId}' not found`, 404)
    }

    const state = JSON.parse(stored[0].value) as ExportState

    return createResponse(
        {
            exportId: state.exportId,
            status: state.status,
            r2Key: state.r2Key,
            tablesTotal: state.tables.length,
            currentTableIndex: state.currentTableIndex,
            startedAt: state.startedAt,
            completedAt: state.completedAt,
            error: state.error,
        },
        undefined,
        200
    )
}

/**
 * Streams a completed export file from R2 back to the caller.
 */
export async function downloadExport(opts: {
    dataSource: DataSource
    exportId: string
    r2Bucket: R2Bucket
}): Promise<Response> {
    const { dataSource, exportId, r2Bucket } = opts

    const stored = await dataSource.rpc.executeQuery({
        sql: `SELECT value FROM tmp_export_state WHERE export_id = ?;`,
        params: [exportId],
    }) as unknown as { value: string }[]

    if (!stored.length) {
        return createResponse(undefined, `Export '${exportId}' not found`, 404)
    }

    const state = JSON.parse(stored[0].value) as ExportState

    if (state.status !== 'completed') {
        return createResponse(
            { exportId: state.exportId, status: state.status },
            `Export is not yet complete (current status: ${state.status})`,
            409
        )
    }

    const object = await r2Bucket.get(state.r2Key)
    if (!object) {
        return createResponse(undefined, 'Export file not found in R2', 404)
    }

    return new Response(object.body, {
        headers: {
            'Content-Type': 'application/sql',
            'Content-Disposition': `attachment; filename="${state.r2Key}"`,
            'Content-Length': String(object.size),
        },
    })
}

/**
 * Called from the DO alarm handler to continue an in-progress export.
 */
export async function continueExportFromAlarm(opts: {
    dataSource: DataSource
    config: StarbaseDBConfiguration
    r2Bucket: R2Bucket
}): Promise<void> {
    const { dataSource, config, r2Bucket } = opts

    // Find any running export
    const stored = await dataSource.rpc.executeQuery({
        sql: `SELECT export_id, value FROM tmp_export_state WHERE value LIKE '%"status":"running"%' LIMIT 1;`,
    }) as unknown as { export_id: string; value: string }[]

    if (!stored.length) return

    const exportId = stored[0].export_id

    // Re-enter the export loop using the persisted state
    await startStreamingDump({
        dataSource,
        config,
        r2Bucket,
        resumeExportId: exportId,
    })
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function persistState(
    dataSource: DataSource,
    state: ExportState
): Promise<void> {
    await dataSource.rpc.executeQuery({
        sql: `INSERT OR REPLACE INTO tmp_export_state (export_id, value) VALUES (?, ?);`,
        params: [state.exportId, JSON.stringify(state)],
    })
}
