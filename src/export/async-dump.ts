import {
    createStreamingExportResponse,
    executeOperation,
    quoteIdentifier,
} from '.'
import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { createResponse } from '../utils'

const DEFAULT_PAGE_SIZE = 500
const DEFAULT_SLICE_MS = 1500
const CALLBACK_RETRY_BASE_MS = 5000
const CALLBACK_RETRY_MAX_MS = 10 * 60 * 1000
const encoder = new TextEncoder()

type ExportR2Bucket = {
    put: (
        key: string,
        value: ReadableStream | ArrayBuffer | ArrayBufferView | string,
        options?: {
            httpMetadata?: {
                contentType?: string
            }
        }
    ) => Promise<unknown>
    get: (key: string) => Promise<{ body: ReadableStream | null } | null>
}

type StartAsyncDumpRequestBody = {
    callbackUrl?: string
}

type DumpJobRow = {
    id: string
    status: 'processing' | 'completed' | 'failed'
    error: string | null
    callback_url: string | null
    callback_sent: number
    callback_attempts: number
    next_callback_retry_at: number | null
    callback_host: string | null
    artifact_key: string | null
    artifact_provider: string | null
    created_at: number
    updated_at: number
    started_at: number
    completed_at: number | null
    current_table_index: number
    current_offset: number
    chunk_index: number
    total_tables: number
}

function getExportBucket(dataSource: DataSource): ExportR2Bucket | undefined {
    const context = (dataSource.context || {}) as {
        exportR2Bucket?: ExportR2Bucket
    }

    return context.exportR2Bucket
}

async function scheduleExportAlarm(dataSource: DataSource): Promise<void> {
    if (typeof dataSource.rpc?.setAlarm !== 'function') {
        return
    }

    try {
        await dataSource.rpc.setAlarm(Date.now() + 1000)
    } catch (error) {
        console.error('Failed to schedule export alarm:', error)
    }
}

function createChunkReadStream(
    jobId: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        start: async (controller) => {
            try {
                let offset = 0
                const pageSize = 100

                while (true) {
                    const chunks = await executeOperation(
                        [
                            {
                                sql: `SELECT content
                                      FROM tmp_export_job_chunks
                                      WHERE job_id = ?
                                      ORDER BY chunk_index ASC
                                      LIMIT ? OFFSET ?;`,
                                params: [jobId, pageSize, offset],
                            },
                        ],
                        dataSource,
                        config
                    )

                    if (!chunks.length) {
                        break
                    }

                    for (const chunk of chunks) {
                        controller.enqueue(
                            encoder.encode(String(chunk.content || ''))
                        )
                    }

                    offset += chunks.length
                    if (chunks.length < pageSize) {
                        break
                    }
                }

                controller.close()
            } catch (error) {
                controller.error(error)
            }
        },
    })
}

async function uploadDumpToR2(
    job: DumpJobRow,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<void> {
    const bucket = getExportBucket(dataSource)
    const artifactKey = job.artifact_key

    if (!bucket || !artifactKey) {
        return
    }

    try {
        await bucket.put(
            artifactKey,
            createChunkReadStream(job.id, dataSource, config),
            {
                httpMetadata: {
                    contentType: 'application/x-sqlite3',
                },
            }
        )

        await executeOperation(
            [
                {
                    sql: `UPDATE tmp_export_jobs
                          SET artifact_provider = 'r2',
                              updated_at = ?
                          WHERE id = ?;`,
                    params: [Date.now(), job.id],
                },
            ],
            dataSource,
            config
        )

        await executeOperation(
            [
                {
                    sql: `DELETE FROM tmp_export_job_chunks WHERE job_id = ?;`,
                    params: [job.id],
                },
            ],
            dataSource,
            config
        )
    } catch (error) {
        console.error('Failed to upload dump artifact to R2:', error)
    }
}

async function maybeNotifyCallback(
    job: DumpJobRow,
    request: Request,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<void> {
    if (!job.callback_url || Number(job.callback_sent || 0) === 1) {
        return
    }

    if (job.status !== 'completed' && job.status !== 'failed') {
        return
    }

    if (
        job.next_callback_retry_at &&
        Number(job.next_callback_retry_at) > Date.now()
    ) {
        return
    }

    try {
        const base = new URL(request.url)
        await fetch(job.callback_url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                jobId: job.id,
                status: job.status,
                error: job.error,
                statusUrl: `${base.origin}/export/dump/${job.id}`,
                downloadUrl:
                    job.status === 'completed'
                        ? `${base.origin}/export/dump/${job.id}/download`
                        : undefined,
            }),
        })

        await executeOperation(
            [
                {
                    sql: `UPDATE tmp_export_jobs
                          SET callback_sent = 1,
                              next_callback_retry_at = NULL,
                              updated_at = ?
                          WHERE id = ?;`,
                    params: [Date.now(), job.id],
                },
            ],
            dataSource,
            config
        )
    } catch (error) {
        console.error('Failed to notify callback URL for dump export:', error)

        const nextAttempt = Number(job.callback_attempts || 0) + 1
        const retryDelay = Math.min(
            CALLBACK_RETRY_BASE_MS * 2 ** (nextAttempt - 1),
            CALLBACK_RETRY_MAX_MS
        )
        const retryAt = Date.now() + retryDelay

        await executeOperation(
            [
                {
                    sql: `UPDATE tmp_export_jobs
                          SET callback_attempts = ?,
                              next_callback_retry_at = ?,
                              error = ?,
                              updated_at = ?
                          WHERE id = ?;`,
                    params: [
                        nextAttempt,
                        retryAt,
                        error instanceof Error
                            ? error.message
                            : 'Failed callback notification.',
                        Date.now(),
                        job.id,
                    ],
                },
            ],
            dataSource,
            config
        )

        await scheduleExportAlarm(dataSource)
    }
}

function toSqlLiteral(value: unknown): string {
    if (value === null || value === undefined) {
        return 'NULL'
    }

    if (typeof value === 'string') {
        return `'${value.replace(/'/g, "''")}'`
    }

    if (typeof value === 'number' || typeof value === 'bigint') {
        return String(value)
    }

    if (typeof value === 'boolean') {
        return value ? '1' : '0'
    }

    return `'${JSON.stringify(value).replace(/'/g, "''")}'`
}

async function getDumpJob(
    jobId: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<DumpJobRow | null> {
    const result = await executeOperation(
        [
            {
                sql: 'SELECT * FROM tmp_export_jobs WHERE id = ? LIMIT 1;',
                params: [jobId],
            },
        ],
        dataSource,
        config
    )

    return result.length ? (result[0] as DumpJobRow) : null
}

async function appendDumpChunk(
    jobId: string,
    chunkIndex: number,
    content: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<void> {
    await executeOperation(
        [
            {
                sql: `INSERT INTO tmp_export_job_chunks (job_id, chunk_index, content) VALUES (?, ?, ?);`,
                params: [jobId, chunkIndex, content],
            },
        ],
        dataSource,
        config
    )
}

async function processDumpJobSlice(opts: {
    jobId: string
    request: Request
    dataSource: DataSource
    config: StarbaseDBConfiguration
    pageSize?: number
    maxDurationMs?: number
}): Promise<DumpJobRow> {
    const {
        jobId,
        request,
        dataSource,
        config,
        pageSize = DEFAULT_PAGE_SIZE,
        maxDurationMs = DEFAULT_SLICE_MS,
    } = opts

    const startedAt = Date.now()
    let job = await getDumpJob(jobId, dataSource, config)

    if (!job) {
        throw new Error('Export job not found.')
    }

    if (job.status !== 'processing') {
        return job
    }

    let tableIndex = Number(job.current_table_index || 0)
    let offset = Number(job.current_offset || 0)
    let chunkIndex = Number(job.chunk_index || 0)

    try {
        while (Date.now() - startedAt < maxDurationMs) {
            if (tableIndex >= Number(job.total_tables || 0)) {
                const completedAt = Date.now()
                await executeOperation(
                    [
                        {
                            sql: `UPDATE tmp_export_jobs
                                  SET status = 'completed',
                                      completed_at = ?,
                                      updated_at = ?,
                                      current_table_index = ?,
                                      current_offset = ?,
                                      chunk_index = ?
                                  WHERE id = ?;`,
                            params: [
                                completedAt,
                                completedAt,
                                tableIndex,
                                offset,
                                chunkIndex,
                                jobId,
                            ],
                        },
                    ],
                    dataSource,
                    config
                )
                break
            }

            const tableResult = await executeOperation(
                [
                    {
                        sql: `SELECT table_name
                              FROM tmp_export_job_tables
                              WHERE job_id = ? AND table_index = ?
                              LIMIT 1;`,
                        params: [jobId, tableIndex],
                    },
                ],
                dataSource,
                config
            )

            if (!tableResult.length) {
                tableIndex += 1
                offset = 0
                continue
            }

            const tableName = String(tableResult[0].table_name)

            if (offset === 0) {
                const schemaResult = await executeOperation(
                    [
                        {
                            sql: `SELECT sql FROM sqlite_master WHERE type='table' AND name=?;`,
                            params: [tableName],
                        },
                    ],
                    dataSource,
                    config
                )

                if (schemaResult.length && schemaResult[0].sql) {
                    await appendDumpChunk(
                        jobId,
                        chunkIndex,
                        `\n-- Table: ${tableName}\n${schemaResult[0].sql};\n\n`,
                        dataSource,
                        config
                    )
                    chunkIndex += 1
                }
            }

            const rows = await executeOperation(
                [
                    {
                        sql: `SELECT * FROM ${quoteIdentifier(tableName)} LIMIT ? OFFSET ?;`,
                        params: [pageSize, offset],
                    },
                ],
                dataSource,
                config
            )

            if (!rows.length) {
                await appendDumpChunk(
                    jobId,
                    chunkIndex,
                    '\n',
                    dataSource,
                    config
                )
                chunkIndex += 1
                tableIndex += 1
                offset = 0
                continue
            }

            const insertStatements = rows
                .map((row: Record<string, unknown>) => {
                    const values = Object.values(row).map((value) =>
                        toSqlLiteral(value)
                    )
                    return `INSERT INTO ${quoteIdentifier(tableName)} VALUES (${values.join(', ')});\n`
                })
                .join('')

            await appendDumpChunk(
                jobId,
                chunkIndex,
                insertStatements,
                dataSource,
                config
            )
            chunkIndex += 1

            offset += rows.length
            if (rows.length < pageSize) {
                await appendDumpChunk(
                    jobId,
                    chunkIndex,
                    '\n',
                    dataSource,
                    config
                )
                chunkIndex += 1
                tableIndex += 1
                offset = 0
            }

            await executeOperation(
                [
                    {
                        sql: `UPDATE tmp_export_jobs
                              SET current_table_index = ?,
                                  current_offset = ?,
                                  chunk_index = ?,
                                  updated_at = ?
                              WHERE id = ?;`,
                        params: [
                            tableIndex,
                            offset,
                            chunkIndex,
                            Date.now(),
                            jobId,
                        ],
                    },
                ],
                dataSource,
                config
            )
        }
    } catch (error: any) {
        await executeOperation(
            [
                {
                    sql: `UPDATE tmp_export_jobs
                          SET status = 'failed',
                              error = ?,
                              updated_at = ?
                          WHERE id = ?;`,
                    params: [
                        error?.message || 'Failed to process dump job.',
                        Date.now(),
                        jobId,
                    ],
                },
            ],
            dataSource,
            config
        )
    }

    let refreshed = await getDumpJob(jobId, dataSource, config)
    if (!refreshed) {
        throw new Error('Export job not found.')
    }

    if (refreshed.status === 'completed') {
        await uploadDumpToR2(refreshed, dataSource, config)
        refreshed = (await getDumpJob(jobId, dataSource, config)) || refreshed
    }

    await maybeNotifyCallback(refreshed, request, dataSource, config)

    if (refreshed.status === 'processing') {
        await scheduleExportAlarm(dataSource)
    }

    return refreshed
}

export async function startAsyncDumpRoute(
    request: Request,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<Response> {
    try {
        const jobId = crypto.randomUUID()
        const now = Date.now()
        let callbackUrl: string | undefined

        if (request.headers.get('Content-Type')?.includes('application/json')) {
            const body = (await request.json()) as StartAsyncDumpRequestBody
            callbackUrl = body?.callbackUrl
        }

        if (callbackUrl) {
            try {
                new URL(callbackUrl)
            } catch {
                return createResponse(
                    undefined,
                    'callbackUrl must be a valid absolute URL.',
                    400
                )
            }
        }

        const artifactKey = `dump_${jobId}.sql`
        const callbackHost = new URL(request.url).origin

        const tables = await executeOperation(
            [{ sql: "SELECT name FROM sqlite_master WHERE type='table';" }],
            dataSource,
            config
        )

        const exportableTables = tables
            .map((row: any) => String(row.name))
            .filter((tableName: string) => !tableName.startsWith('tmp_'))

        await executeOperation(
            [
                {
                    sql: `INSERT INTO tmp_export_jobs (
                        id,
                        status,
                        error,
                        created_at,
                        updated_at,
                        started_at,
                        completed_at,
                        callback_url,
                        callback_sent,
                        callback_attempts,
                        next_callback_retry_at,
                        callback_host,
                        artifact_key,
                        artifact_provider,
                        current_table_index,
                        current_offset,
                        chunk_index,
                        total_tables
                    ) VALUES (?, 'processing', NULL, ?, ?, ?, NULL, ?, 0, 0, NULL, ?, ?, NULL, 0, 0, 0, ?);`,
                    params: [
                        jobId,
                        now,
                        now,
                        now,
                        callbackUrl || null,
                        callbackHost,
                        artifactKey,
                        exportableTables.length,
                    ],
                },
            ],
            dataSource,
            config
        )

        for (let index = 0; index < exportableTables.length; index += 1) {
            await executeOperation(
                [
                    {
                        sql: `INSERT INTO tmp_export_job_tables (job_id, table_index, table_name) VALUES (?, ?, ?);`,
                        params: [jobId, index, exportableTables[index]],
                    },
                ],
                dataSource,
                config
            )
        }

        await appendDumpChunk(jobId, 0, 'SQLite format 3\0', dataSource, config)

        await executeOperation(
            [
                {
                    sql: `UPDATE tmp_export_jobs SET chunk_index = 1, updated_at = ? WHERE id = ?;`,
                    params: [Date.now(), jobId],
                },
            ],
            dataSource,
            config
        )

        const processedJob = await processDumpJobSlice({
            jobId,
            request,
            dataSource,
            config,
        })

        const base = new URL(request.url)
        const statusPath = `/export/dump/${jobId}`
        const downloadPath = `/export/dump/${jobId}/download`

        return createResponse(
            {
                jobId,
                status: processedJob.status,
                statusUrl: `${base.origin}${statusPath}`,
                downloadUrl:
                    processedJob.status === 'completed'
                        ? `${base.origin}${downloadPath}`
                        : undefined,
                artifactProvider:
                    processedJob.artifact_provider || 'durable-object',
            },
            undefined,
            processedJob.status === 'completed' ? 201 : 202
        )
    } catch (error: any) {
        console.error('Async Dump Start Error:', error)
        return createResponse(
            undefined,
            error?.message || 'Failed to start dump export.',
            500
        )
    }
}

export async function getAsyncDumpStatusRoute(
    jobId: string,
    request: Request,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<Response> {
    try {
        let job = await getDumpJob(jobId, dataSource, config)
        if (!job) {
            return createResponse(undefined, 'Export job not found.', 404)
        }

        if (job.status === 'processing') {
            job = await processDumpJobSlice({
                jobId,
                request,
                dataSource,
                config,
            })
        }

        await maybeNotifyCallback(job, request, dataSource, config)
        job = (await getDumpJob(jobId, dataSource, config)) || job

        const base = new URL(request.url)

        return createResponse(
            {
                jobId: job.id,
                status: job.status,
                error: job.error,
                progress: {
                    currentTableIndex: Number(job.current_table_index || 0),
                    totalTables: Number(job.total_tables || 0),
                    currentOffset: Number(job.current_offset || 0),
                },
                callback: {
                    sent: Number(job.callback_sent || 0) === 1,
                    attempts: Number(job.callback_attempts || 0),
                    nextRetryAt: job.next_callback_retry_at
                        ? Number(job.next_callback_retry_at)
                        : undefined,
                },
                downloadUrl:
                    job.status === 'completed'
                        ? `${base.origin}/export/dump/${job.id}/download`
                        : undefined,
                artifactProvider: job.artifact_provider || 'durable-object',
                updatedAt: Number(job.updated_at || 0),
            },
            undefined,
            200
        )
    } catch (error: any) {
        console.error('Async Dump Status Error:', error)
        return createResponse(
            undefined,
            error?.message || 'Failed to retrieve export status.',
            500
        )
    }
}

export async function downloadAsyncDumpRoute(
    jobId: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<Response> {
    try {
        const job = await getDumpJob(jobId, dataSource, config)

        if (!job) {
            return createResponse(undefined, 'Export job not found.', 404)
        }

        if (job.status !== 'completed') {
            await scheduleExportAlarm(dataSource)
            return createResponse(
                {
                    status: job.status,
                },
                'Export is not complete yet.',
                409
            )
        }

        const bucket = getExportBucket(dataSource)
        if (bucket && job.artifact_provider === 'r2' && job.artifact_key) {
            const object = await bucket.get(job.artifact_key)

            if (object?.body) {
                return createStreamingExportResponse(
                    object.body,
                    `database_dump_${jobId}.sql`,
                    'application/x-sqlite3'
                )
            }

            return createResponse(
                undefined,
                'Dump artifact is unavailable in R2 storage.',
                500
            )
        }

        const stream = createChunkReadStream(jobId, dataSource, config)

        return createStreamingExportResponse(
            stream,
            `database_dump_${jobId}.sql`,
            'application/x-sqlite3'
        )
    } catch (error: any) {
        console.error('Async Dump Download Error:', error)
        return createResponse(
            undefined,
            error?.message || 'Failed to download export.',
            500
        )
    }
}
