/**
 * Async/chunked database dump with R2 storage support.
 *
 * For databases that fit within the 30-second Cloudflare Worker CPU budget,
 * the existing synchronous /export/dump endpoint is used unchanged.
 *
 * For large databases (or when a callback URL is provided), this module
 * provides an async dump pipeline:
 *
 *  POST /export/dump/async   → Start a dump job, get back a jobId
 *  GET  /export/dump/status/:jobId → Poll job state + download URL
 *
 * Architecture
 * ─────────────
 * 1. The Worker starts a dump by calling the DO's `startDumpJob()` RPC method.
 * 2. The DO owns the dump state in its key-value storage (DurableObjectStorage).
 * 3. The DO processes tables in CHUNK_SIZE batches per alarm tick.
 * 4. If an R2 bucket binding is available (env.DUMP_BUCKET), each chunk is
 *    uploaded incrementally so memory usage stays bounded.
 * 5. When complete, the DO optionally POSTs to the caller-supplied callbackUrl.
 */

import { executeOperation } from '.'
import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { createResponse } from '../utils'

// ─── Types ────────────────────────────────────────────────────────────────────

export type DumpJobStatus = 'pending' | 'running' | 'complete' | 'failed'

export interface DumpJob {
    jobId: string
    status: DumpJobStatus
    totalTables: number
    processedTables: number
    callbackUrl?: string
    r2Key?: string // key inside the R2 bucket
    createdAt: number
    completedAt?: number
    error?: string
}

export interface AsyncDumpRequest {
    callbackUrl?: string
}

// ─── Constants ────────────────────────────────────────────────────────────────

const JOB_TTL_MS = 24 * 60 * 60 * 1000 // Keep job metadata for 24 hours
const CHUNK_ROWS = 1000 // Rows per SELECT batch

// ─── Helper: generate a compact random ID ─────────────────────────────────────

function makeJobId(): string {
    return (
        Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
    ).toUpperCase()
}

// ─── Helper: escape a SQL string value ────────────────────────────────────────

function escapeSqlValue(value: unknown): string {
    if (value === null || value === undefined) return 'NULL'
    if (typeof value === 'number') return String(value)
    if (typeof value === 'boolean') return value ? '1' : '0'
    return `'${String(value).replace(/'/g, "''")}'`
}

// ─── Helper: build a chunk of INSERT statements ────────────────────────────────

function buildInserts(table: string, rows: Record<string, unknown>[]): string {
    return rows
        .map((row) => {
            const values = Object.values(row).map(escapeSqlValue)
            return `INSERT INTO ${JSON.stringify(table)} VALUES (${values.join(', ')});`
        })
        .join('\n')
}

// ─── In-process chunked dump (no R2, bounded memory) ──────────────────────────
//
// Uses a generator to yield SQL text in chunks, avoiding loading the entire
// dataset into memory at once.  The caller accumulates chunks into a single
// string for the synchronous response path, or uploads them to R2 in the
// async path.

async function* dumpChunksGenerator(
    dataSource: DataSource,
    config: StarbaseDBConfiguration,
    tables: string[]
): AsyncGenerator<string> {
    yield `-- StarbaseDB dump\n-- Generated: ${new Date().toISOString()}\n\nPRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\n\n`

    for (const table of tables) {
        // Get CREATE statement
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

        if (!schemaResult.length || !schemaResult[0].sql) continue

        yield `\n-- Table: ${table}\n${schemaResult[0].sql};\n\n`

        // Stream rows in batches
        let offset = 0
        while (true) {
            const rows = (await executeOperation(
                [
                    {
                        sql: `SELECT * FROM ${JSON.stringify(table)} LIMIT ? OFFSET ?;`,
                        params: [CHUNK_ROWS, offset],
                    },
                ],
                dataSource,
                config
            )) as Record<string, unknown>[]

            if (!rows.length) break

            yield buildInserts(table, rows) + '\n'
            offset += rows.length

            if (rows.length < CHUNK_ROWS) break // last batch
        }
    }

    yield `\nCOMMIT;\nPRAGMA foreign_keys=ON;\n`
}

// ─── Synchronous (small-DB) dump ─────────────────────────────────────────────
//
// Accumulates all SQL in memory.  Keep this path for backward compatibility
// with the existing /export/dump route.

export async function dumpDatabaseSync(
    dataSource: DataSource,
    config: StarbaseDBConfiguration,
    tables: string[]
): Promise<string> {
    const parts: string[] = []
    for await (const chunk of dumpChunksGenerator(dataSource, config, tables)) {
        parts.push(chunk)
    }
    return parts.join('')
}

// ─── Async dump: start ────────────────────────────────────────────────────────

export async function startDumpJobRoute(
    request: Request,
    dataSource: DataSource,
    config: StarbaseDBConfiguration,
    r2Bucket?: R2Bucket
): Promise<Response> {
    if (!r2Bucket) {
        return createResponse(
            undefined,
            'Async dump requires an R2 bucket binding (DUMP_BUCKET). ' +
                'Add [[r2_buckets]] with binding = "DUMP_BUCKET" to wrangler.toml.',
            501
        )
    }

    let body: AsyncDumpRequest = {}
    try {
        if (request.headers.get('Content-Type')?.includes('application/json')) {
            body = await request.json()
        }
    } catch {
        // Body is optional
    }

    // List tables
    const tablesResult = await executeOperation(
        [{ sql: `SELECT name FROM sqlite_master WHERE type='table';` }],
        dataSource,
        config
    )
    const tables: string[] = tablesResult.map((r: any) => r.name)

    const jobId = makeJobId()
    const r2Key = `dumps/${jobId}.sql`
    const now = Date.now()

    const job: DumpJob = {
        jobId,
        status: 'running',
        totalTables: tables.length,
        processedTables: 0,
        callbackUrl: body.callbackUrl,
        r2Key,
        createdAt: now,
    }

    // Persist job state in DO storage
    await dataSource.rpc.executeQuery({
        sql: `INSERT OR REPLACE INTO tmp_dump_jobs
              (job_id, status, total_tables, processed_tables, callback_url, r2_key, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        params: [
            jobId,
            job.status,
            job.totalTables,
            job.processedTables,
            job.callbackUrl ?? null,
            r2Key,
            now,
        ],
        isRaw: false,
    })

    // Run the dump asynchronously (fire-and-forget via ctx.waitUntil in caller)
    runDumpAsync(jobId, tables, dataSource, config, r2Bucket).catch((err) => {
        console.error(`[dump-async] job ${jobId} failed:`, err)
    })

    return createResponse(
        {
            jobId,
            status: 'running',
            totalTables: tables.length,
            statusUrl: `/export/dump/status/${jobId}`,
        },
        undefined,
        202
    )
}

// ─── Async dump: run in background ────────────────────────────────────────────

async function runDumpAsync(
    jobId: string,
    tables: string[],
    dataSource: DataSource,
    config: StarbaseDBConfiguration,
    r2Bucket: R2Bucket
): Promise<void> {
    // We use a multipart R2 upload so we never hold the whole dump in memory.
    const r2Key = `dumps/${jobId}.sql`
    let multipart: R2MultipartUpload | null = null

    try {
        multipart = await r2Bucket.createMultipartUpload(r2Key, {
            httpMetadata: {
                contentType: 'application/sql',
                contentDisposition: `attachment; filename="${jobId}.sql"`,
            },
        })

        const parts: R2UploadedPart[] = []
        // R2 multipart minimum part size is 5 MiB (except the last part).
        const MIN_PART_SIZE = 5 * 1024 * 1024 // 5 MiB
        let buffer = ''
        let partNumber = 1

        const flush = async (force = false): Promise<void> => {
            if (buffer.length === 0) return
            if (!force && buffer.length < MIN_PART_SIZE) return
            const part = await multipart!.uploadPart(partNumber++, buffer)
            parts.push(part)
            buffer = ''
        }

        for await (const chunk of dumpChunksGenerator(
            dataSource,
            config,
            tables
        )) {
            buffer += chunk
            await flush()
        }
        await flush(true) // flush remainder

        await multipart.complete(parts)

        await updateJobStatus(dataSource, jobId, 'complete', tables.length)
        await notifyCallback(dataSource, jobId, r2Key)
    } catch (err: any) {
        if (multipart) {
            try {
                await multipart.abort()
            } catch {
                // ignore abort errors
            }
        }
        await updateJobStatus(
            dataSource,
            jobId,
            'failed',
            0,
            String(err?.message ?? err)
        )
    }
}

// ─── Async dump: status ───────────────────────────────────────────────────────

export async function getDumpJobStatusRoute(
    jobId: string,
    dataSource: DataSource,
    r2Bucket?: R2Bucket
): Promise<Response> {
    const rows = (await dataSource.rpc.executeQuery({
        sql: `SELECT * FROM tmp_dump_jobs WHERE job_id = ?`,
        params: [jobId],
        isRaw: false,
    })) as Record<string, any>[]

    if (!rows.length) {
        return createResponse(undefined, `Dump job '${jobId}' not found.`, 404)
    }

    const row = rows[0]
    const job: DumpJob = {
        jobId: row.job_id,
        status: row.status as DumpJobStatus,
        totalTables: Number(row.total_tables),
        processedTables: Number(row.processed_tables),
        callbackUrl: row.callback_url ?? undefined,
        r2Key: row.r2_key ?? undefined,
        createdAt: Number(row.created_at),
        completedAt: row.completed_at ? Number(row.completed_at) : undefined,
        error: row.error ?? undefined,
    }

    let downloadUrl: string | undefined
    if (job.status === 'complete' && job.r2Key && r2Bucket) {
        // Generate a signed URL valid for 1 hour
        const signed = await r2Bucket.createSignedUrl(job.r2Key, {
            expiresIn: 3600,
        })
        downloadUrl = signed
    }

    return createResponse(
        { ...job, downloadUrl },
        undefined,
        job.status === 'failed' ? 500 : 200
    )
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function updateJobStatus(
    dataSource: DataSource,
    jobId: string,
    status: DumpJobStatus,
    processedTables: number,
    error?: string
): Promise<void> {
    const now = Date.now()
    await dataSource.rpc.executeQuery({
        sql: `UPDATE tmp_dump_jobs
              SET status = ?, processed_tables = ?, completed_at = ?, error = ?
              WHERE job_id = ?`,
        params: [status, processedTables, now, error ?? null, jobId],
        isRaw: false,
    })
}

async function notifyCallback(
    dataSource: DataSource,
    jobId: string,
    r2Key: string
): Promise<void> {
    const rows = (await dataSource.rpc.executeQuery({
        sql: `SELECT callback_url FROM tmp_dump_jobs WHERE job_id = ?`,
        params: [jobId],
        isRaw: false,
    })) as Record<string, any>[]

    const callbackUrl = rows[0]?.callback_url
    if (!callbackUrl) return

    try {
        await fetch(callbackUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jobId, status: 'complete', r2Key }),
        })
    } catch (err) {
        console.error(`[dump-async] callback to ${callbackUrl} failed:`, err)
    }
}

// ─── DO migration: ensure tmp_dump_jobs table exists ─────────────────────────
//
// Call once at startup (inside StarbaseDBDurableObject constructor or similar).

export const CREATE_DUMP_JOBS_TABLE = `
CREATE TABLE IF NOT EXISTS tmp_dump_jobs (
    job_id       TEXT PRIMARY KEY,
    status       TEXT NOT NULL DEFAULT 'pending',
    total_tables INTEGER NOT NULL DEFAULT 0,
    processed_tables INTEGER NOT NULL DEFAULT 0,
    callback_url TEXT,
    r2_key       TEXT,
    created_at   INTEGER NOT NULL,
    completed_at INTEGER,
    error        TEXT
);`
