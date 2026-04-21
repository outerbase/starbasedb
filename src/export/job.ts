import { DataSource } from '../types'
import { StarbaseDBConfiguration } from '../handler'
import { executeOperation } from '.'
import { formatChunkAsSQL, formatChunkAsJSON, formatChunkAsCSV } from './format'

export type ExportJob = {
    id: string
    format: 'sql' | 'json' | 'csv'
    status: 'pending' | 'in_progress' | 'completed' | 'failed'
    target_table: string | null
    r2_key: string
    r2_upload_id: string | null
    current_table: string | null
    current_offset: number
    total_tables: number | null
    completed_tables: number
    bytes_written: number
    parts_uploaded: string
    callback_url: string | null
    error_message: string | null
    created_at: string
    completed_at: string | null
}

export function generateJobId(): string {
    const now = new Date()
    const pad = (n: number, len = 2) => String(n).padStart(len, '0')
    const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    const rand = Math.random().toString(36).substring(2, 8)
    return `export_${ts}_${rand}`
}

export async function createExportJob(opts: {
    format: 'sql' | 'json' | 'csv'
    targetTable?: string
    callbackUrl?: string
    dataSource: DataSource
    config: StarbaseDBConfiguration
}): Promise<{ jobId: string; statusUrl: string; estimatedTables: number }> {
    const { format, targetTable, callbackUrl, dataSource, config } = opts
    const bucket = dataSource.r2ExportBucket
    if (!bucket) {
        throw new Error(
            'Async exports require the EXPORT_BUCKET R2 binding to be configured'
        )
    }

    const jobId = generateJobId()
    const ext = format === 'sql' ? 'sql' : format === 'json' ? 'json' : 'csv'
    const prefix = targetTable ? targetTable : 'dump'
    const now = new Date()
    const pad = (n: number, len = 2) => String(n).padStart(len, '0')
    const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    const r2Key = `exports/${prefix}_${ts}.${ext}`

    const multipartUpload = await bucket.createMultipartUpload(r2Key)

    let totalTables = 0
    if (!targetTable) {
        const tablesResult = await executeOperation(
            [
                {
                    sql: "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'tmp_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%';",
                },
            ],
            dataSource,
            config
        )
        totalTables = tablesResult.length
    } else {
        totalTables = 1
    }

    await executeOperation(
        [
            {
                sql: `INSERT INTO tmp_export_jobs (id, format, status, target_table, r2_key, r2_upload_id, total_tables, callback_url, parts_uploaded) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, '[]')`,
                params: [
                    jobId,
                    format,
                    targetTable || null,
                    r2Key,
                    multipartUpload.uploadId,
                    totalTables,
                    callbackUrl || null,
                ],
            },
        ],
        dataSource,
        config
    )

    return {
        jobId,
        statusUrl: `/export/jobs/${jobId}`,
        estimatedTables: totalTables,
    }
}

export async function processExportChunk(opts: {
    jobId: string
    dataSource: DataSource
    config: StarbaseDBConfiguration
}): Promise<boolean> {
    const { jobId, dataSource, config } = opts
    const bucket = dataSource.r2ExportBucket
    if (!bucket) throw new Error('EXPORT_BUCKET not configured')

    const job = await getExportJob(jobId, dataSource, config)
    if (!job) throw new Error(`Export job ${jobId} not found`)

    if (job.status === 'pending') {
        await executeOperation(
            [
                {
                    sql: `UPDATE tmp_export_jobs SET status = 'in_progress' WHERE id = ?`,
                    params: [jobId],
                },
            ],
            dataSource,
            config
        )
    }

    const BATCH_SIZE = 5000
    const TIME_BUDGET_MS = 4500
    const startTime = Date.now()

    let tables: string[] = []
    if (job.target_table) {
        tables = [job.target_table]
    } else {
        const tablesResult = await executeOperation(
            [
                {
                    sql: "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'tmp_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%' ORDER BY name;",
                },
            ],
            dataSource,
            config
        )
        tables = tablesResult.map((r: any) => r.name)
    }

    if (tables.length === 0) {
        return false
    }

    let currentTableIndex = 0
    if (job.current_table) {
        const idx = tables.indexOf(job.current_table)
        if (idx >= 0) currentTableIndex = idx
    }
    let currentOffset = job.current_offset || 0

    const multipartUpload = bucket.resumeMultipartUpload(
        job.r2_key,
        job.r2_upload_id!
    )

    let existingParts: R2UploadedPart[] = []
    try {
        existingParts = JSON.parse(job.parts_uploaded || '[]')
    } catch {
        existingParts = []
    }
    let partNumber = existingParts.length + 1

    let chunkData = ''

    while (currentTableIndex < tables.length) {
        if (Date.now() - startTime > TIME_BUDGET_MS) break

        const tableName = tables[currentTableIndex]

        if (currentOffset === 0 && job.format === 'sql') {
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
            if (schemaResult.length > 0) {
                chunkData += `\n-- Table: ${tableName}\n${schemaResult[0].sql};\n\n`
            }
        }

        const rows = await executeOperation(
            [
                {
                    sql: `SELECT * FROM "${tableName}" LIMIT ? OFFSET ?;`,
                    params: [BATCH_SIZE, currentOffset],
                },
            ],
            dataSource,
            config
        )

        if (rows.length > 0) {
            const isFirstChunk =
                currentTableIndex === 0 &&
                currentOffset === 0 &&
                existingParts.length === 0
            const isLastChunk =
                rows.length < BATCH_SIZE &&
                currentTableIndex === tables.length - 1

            if (job.format === 'sql') {
                chunkData += formatChunkAsSQL(tableName, rows)
            } else if (job.format === 'json') {
                chunkData += formatChunkAsJSON(rows, isFirstChunk, isLastChunk)
            } else if (job.format === 'csv') {
                const includeHeaders =
                    currentTableIndex === 0 &&
                    currentOffset === 0 &&
                    existingParts.length === 0
                chunkData += formatChunkAsCSV(rows, includeHeaders)
            }
        }

        if (rows.length < BATCH_SIZE) {
            currentTableIndex++
            currentOffset = 0
        } else {
            currentOffset += BATCH_SIZE
        }

        if (Date.now() - startTime > TIME_BUDGET_MS) break
    }

    if (chunkData.length > 0) {
        const encoder = new TextEncoder()
        const partData = encoder.encode(chunkData)
        const uploadedPart = await multipartUpload.uploadPart(
            partNumber,
            partData
        )
        existingParts.push(uploadedPart)
    }

    const hasMore = currentTableIndex < tables.length
    const newBytesWritten =
        job.bytes_written + new TextEncoder().encode(chunkData).byteLength

    await executeOperation(
        [
            {
                sql: `UPDATE tmp_export_jobs SET current_table = ?, current_offset = ?, completed_tables = ?, bytes_written = ?, parts_uploaded = ? WHERE id = ?`,
                params: [
                    currentTableIndex < tables.length
                        ? tables[currentTableIndex]
                        : null,
                    currentOffset,
                    Math.min(currentTableIndex, tables.length),
                    newBytesWritten,
                    JSON.stringify(
                        existingParts.map((p) => ({
                            partNumber: p.partNumber,
                            etag: p.etag,
                        }))
                    ),
                    jobId,
                ],
            },
        ],
        dataSource,
        config
    )

    return hasMore
}

export async function completeExportJob(opts: {
    jobId: string
    dataSource: DataSource
    config: StarbaseDBConfiguration
}): Promise<void> {
    const { jobId, dataSource, config } = opts
    const bucket = dataSource.r2ExportBucket
    if (!bucket) throw new Error('EXPORT_BUCKET not configured')

    const job = await getExportJob(jobId, dataSource, config)
    if (!job) throw new Error(`Export job ${jobId} not found`)

    const multipartUpload = bucket.resumeMultipartUpload(
        job.r2_key,
        job.r2_upload_id!
    )

    let parts: R2UploadedPart[] = []
    try {
        parts = JSON.parse(job.parts_uploaded || '[]')
    } catch {
        parts = []
    }

    if (parts.length > 0) {
        await multipartUpload.complete(parts)
    } else {
        // No data was uploaded — abort and create an empty object instead
        await multipartUpload.abort()
        await bucket.put(job.r2_key, '')
    }

    await executeOperation(
        [
            {
                sql: `UPDATE tmp_export_jobs SET status = 'completed', completed_at = datetime('now') WHERE id = ?`,
                params: [jobId],
            },
        ],
        dataSource,
        config
    )
}

export async function failExportJob(opts: {
    jobId: string
    errorMessage: string
    dataSource: DataSource
    config: StarbaseDBConfiguration
}): Promise<void> {
    const { jobId, errorMessage, dataSource, config } = opts
    const bucket = dataSource.r2ExportBucket

    await executeOperation(
        [
            {
                sql: `UPDATE tmp_export_jobs SET status = 'failed', error_message = ?, completed_at = datetime('now') WHERE id = ?`,
                params: [errorMessage, jobId],
            },
        ],
        dataSource,
        config
    )

    // Try to abort the multipart upload
    if (bucket) {
        try {
            const job = await getExportJob(jobId, dataSource, config)
            if (job?.r2_upload_id) {
                const multipartUpload = bucket.resumeMultipartUpload(
                    job.r2_key,
                    job.r2_upload_id
                )
                await multipartUpload.abort()
            }
        } catch (e) {
            console.error('Failed to abort R2 multipart upload:', e)
        }
    }
}

export async function getExportJob(
    jobId: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<ExportJob | null> {
    const result = await executeOperation(
        [
            {
                sql: `SELECT * FROM tmp_export_jobs WHERE id = ?`,
                params: [jobId],
            },
        ],
        dataSource,
        config
    )
    if (result.length === 0) return null
    return result[0] as ExportJob
}

export async function deliverCallback(opts: {
    job: ExportJob
    downloadUrl?: string
}): Promise<void> {
    const { job, downloadUrl } = opts
    if (!job.callback_url) return

    try {
        const payload: Record<string, unknown> = {
            jobId: job.id,
            status: job.status,
        }

        if (job.status === 'completed' && downloadUrl) {
            payload.downloadUrl = downloadUrl
        }

        if (job.status === 'failed' && job.error_message) {
            payload.error_message = job.error_message
        }

        await fetch(job.callback_url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        })
    } catch (e) {
        console.error('Failed to deliver callback:', e)
    }
}
