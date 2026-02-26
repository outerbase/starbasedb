import { executeOperation } from '.'
import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { createResponse } from '../utils'

type DumpJobStatus = 'pending' | 'running' | 'completed' | 'failed'

type DumpJobRecord = {
    job_id: string
    status: DumpJobStatus
    error_message: string | null
    file_name: string
    batch_size: number
    table_index: number
    row_offset: number
    schema_written: number
    chunk_index: number
    tables_json: string
    created_at: number
    updated_at: number
    completed_at: number | null
}

const DEFAULT_BATCH_SIZE = 500
const MIN_BATCH_SIZE = 50
const MAX_BATCH_SIZE = 5000
const STATUS_STEP_BUDGET_MS = 1500
const DOWNLOAD_CHUNK_BATCH_SIZE = 200

const CREATE_DUMP_JOBS_TABLE_SQL = `
    CREATE TABLE IF NOT EXISTS tmp_export_dump_jobs (
        job_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        error_message TEXT,
        file_name TEXT NOT NULL,
        batch_size INTEGER NOT NULL,
        table_index INTEGER NOT NULL DEFAULT 0,
        row_offset INTEGER NOT NULL DEFAULT 0,
        schema_written INTEGER NOT NULL DEFAULT 0,
        chunk_index INTEGER NOT NULL DEFAULT 1,
        tables_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER
    );
`

const CREATE_DUMP_CHUNKS_TABLE_SQL = `
    CREATE TABLE IF NOT EXISTS tmp_export_dump_chunks (
        job_id TEXT NOT NULL,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (job_id, chunk_index)
    );
`

function nowMs(): number {
    return Date.now()
}

function clampBatchSize(value: unknown): number {
    const parsed = Number(value)

    if (!Number.isFinite(parsed)) {
        return DEFAULT_BATCH_SIZE
    }

    return Math.max(MIN_BATCH_SIZE, Math.min(MAX_BATCH_SIZE, Math.floor(parsed)))
}

function quoteIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`
}

function escapeSqlValue(value: unknown): string {
    if (value === null || value === undefined) {
        return 'NULL'
    }

    if (typeof value === 'number' || typeof value === 'bigint') {
        return String(value)
    }

    if (typeof value === 'boolean') {
        return value ? '1' : '0'
    }

    if (value instanceof Uint8Array) {
        const hex = Array.from(value)
            .map((byte) => byte.toString(16).padStart(2, '0'))
            .join('')
        return `X'${hex}'`
    }

    if (typeof value === 'object') {
        return `'${JSON.stringify(value).replace(/'/g, "''")}'`
    }

    return `'${String(value).replace(/'/g, "''")}'`
}

function parseTables(tablesJson: string): string[] {
    try {
        const parsed = JSON.parse(tablesJson)
        return Array.isArray(parsed)
            ? parsed.filter((item): item is string => typeof item === 'string')
            : []
    } catch {
        return []
    }
}

function toDumpJobRecord(row: any): DumpJobRecord {
    return {
        job_id: String(row.job_id),
        status: row.status as DumpJobStatus,
        error_message:
            typeof row.error_message === 'string' ? row.error_message : null,
        file_name: String(row.file_name || 'database_dump.sql'),
        batch_size: Number(row.batch_size || DEFAULT_BATCH_SIZE),
        table_index: Number(row.table_index || 0),
        row_offset: Number(row.row_offset || 0),
        schema_written: Number(row.schema_written || 0),
        chunk_index: Number(row.chunk_index || 0),
        tables_json: String(row.tables_json || '[]'),
        created_at: Number(row.created_at || 0),
        updated_at: Number(row.updated_at || 0),
        completed_at:
            row.completed_at === null || row.completed_at === undefined
                ? null
                : Number(row.completed_at),
    }
}

function summarizeJob(job: DumpJobRecord, chunkCount: number) {
    const tables = parseTables(job.tables_json)
    const totalTables = tables.length
    const completedTables = Math.min(job.table_index, totalTables)
    const progressPercent =
        totalTables === 0
            ? job.status === 'completed'
                ? 100
                : 0
            : Math.min(
                  99,
                  Math.floor((completedTables / totalTables) * 100)
              )

    return {
        jobId: job.job_id,
        status: job.status,
        fileName: job.file_name,
        batchSize: job.batch_size,
        tableIndex: job.table_index,
        rowOffset: job.row_offset,
        totalTables,
        progressPercent: job.status === 'completed' ? 100 : progressPercent,
        chunkCount,
        error: job.error_message,
        createdAt: job.created_at,
        updatedAt: job.updated_at,
        completedAt: job.completed_at,
    }
}

async function ensureDumpJobTables(
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<void> {
    await executeOperation([{ sql: CREATE_DUMP_JOBS_TABLE_SQL }], dataSource, config)
    await executeOperation(
        [{ sql: CREATE_DUMP_CHUNKS_TABLE_SQL }],
        dataSource,
        config
    )
}

async function getDumpJobById(
    jobId: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<DumpJobRecord | null> {
    const rows = await executeOperation(
        [
            {
                sql: 'SELECT * FROM tmp_export_dump_jobs WHERE job_id = ? LIMIT 1;',
                params: [jobId],
            },
        ],
        dataSource,
        config
    )

    if (!rows.length) {
        return null
    }

    return toDumpJobRecord(rows[0])
}

async function getDumpChunkCount(
    jobId: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<number> {
    const rows = await executeOperation(
        [
            {
                sql: 'SELECT COUNT(*) AS count FROM tmp_export_dump_chunks WHERE job_id = ?;',
                params: [jobId],
            },
        ],
        dataSource,
        config
    )

    return Number(rows[0]?.count || 0)
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
                sql: 'INSERT INTO tmp_export_dump_chunks (job_id, chunk_index, content, created_at) VALUES (?, ?, ?, ?);',
                params: [jobId, chunkIndex, content, nowMs()],
            },
        ],
        dataSource,
        config
    )
}

async function markDumpJobFailed(
    jobId: string,
    errorMessage: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<void> {
    const timestamp = nowMs()
    await executeOperation(
        [
            {
                sql: 'UPDATE tmp_export_dump_jobs SET status = ?, error_message = ?, updated_at = ?, completed_at = ? WHERE job_id = ?;',
                params: ['failed', errorMessage, timestamp, timestamp, jobId],
            },
        ],
        dataSource,
        config
    )
}

async function completeDumpJob(
    jobId: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<void> {
    const timestamp = nowMs()
    await executeOperation(
        [
            {
                sql: 'UPDATE tmp_export_dump_jobs SET status = ?, updated_at = ?, completed_at = ? WHERE job_id = ?;',
                params: ['completed', timestamp, timestamp, jobId],
            },
        ],
        dataSource,
        config
    )
}

async function processDumpJobStep(
    job: DumpJobRecord,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<void> {
    const tables = parseTables(job.tables_json)

    if (job.table_index >= tables.length) {
        await completeDumpJob(job.job_id, dataSource, config)
        return
    }

    const tableName = tables[job.table_index]

    if (job.status === 'pending') {
        await executeOperation(
            [
                {
                    sql: 'UPDATE tmp_export_dump_jobs SET status = ?, updated_at = ? WHERE job_id = ?;',
                    params: ['running', nowMs(), job.job_id],
                },
            ],
            dataSource,
            config
        )
    }

    if (job.schema_written === 0) {
        const schemaRows = await executeOperation(
            [
                {
                    sql: 'SELECT sql FROM sqlite_master WHERE type = ? AND name = ? LIMIT 1;',
                    params: ['table', tableName],
                },
            ],
            dataSource,
            config
        )

        const schema =
            typeof schemaRows[0]?.sql === 'string'
                ? `${schemaRows[0].sql};`
                : '-- Schema unavailable'

        await appendDumpChunk(
            job.job_id,
            job.chunk_index,
            `\n-- Table: ${tableName}\n${schema}\n\n`,
            dataSource,
            config
        )

        await executeOperation(
            [
                {
                    sql: 'UPDATE tmp_export_dump_jobs SET schema_written = 1, chunk_index = ?, updated_at = ? WHERE job_id = ?;',
                    params: [job.chunk_index + 1, nowMs(), job.job_id],
                },
            ],
            dataSource,
            config
        )

        return
    }

    const escapedTable = quoteIdentifier(tableName)
    const rows = await executeOperation(
        [
            {
                sql: `SELECT * FROM ${escapedTable} LIMIT ? OFFSET ?;`,
                params: [job.batch_size, job.row_offset],
            },
        ],
        dataSource,
        config
    )

    if (!rows.length) {
        const nextTableIndex = job.table_index + 1

        await appendDumpChunk(
            job.job_id,
            job.chunk_index,
            '\n',
            dataSource,
            config
        )

        await executeOperation(
            [
                {
                    sql: 'UPDATE tmp_export_dump_jobs SET table_index = ?, row_offset = 0, schema_written = 0, chunk_index = ?, updated_at = ? WHERE job_id = ?;',
                    params: [
                        nextTableIndex,
                        job.chunk_index + 1,
                        nowMs(),
                        job.job_id,
                    ],
                },
            ],
            dataSource,
            config
        )

        if (nextTableIndex >= tables.length) {
            await completeDumpJob(job.job_id, dataSource, config)
        }

        return
    }

    const inserts = rows
        .map((row) => {
            const values = Object.values(row).map(escapeSqlValue)
            return `INSERT INTO ${escapedTable} VALUES (${values.join(', ')});`
        })
        .join('\n')

    await appendDumpChunk(
        job.job_id,
        job.chunk_index,
        `${inserts}\n`,
        dataSource,
        config
    )

    await executeOperation(
        [
            {
                sql: 'UPDATE tmp_export_dump_jobs SET row_offset = ?, chunk_index = ?, updated_at = ? WHERE job_id = ?;',
                params: [
                    job.row_offset + rows.length,
                    job.chunk_index + 1,
                    nowMs(),
                    job.job_id,
                ],
            },
        ],
        dataSource,
        config
    )
}

async function processDumpJobWithinBudget(
    jobId: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration,
    maxDurationMs: number
): Promise<void> {
    const startedAt = nowMs()

    while (nowMs() - startedAt < maxDurationMs) {
        const job = await getDumpJobById(jobId, dataSource, config)

        if (!job) {
            return
        }

        if (job.status === 'completed' || job.status === 'failed') {
            return
        }

        try {
            await processDumpJobStep(job, dataSource, config)
        } catch (error: any) {
            console.error('Async dump job step failed:', error)
            await markDumpJobFailed(
                jobId,
                error?.message || 'Failed to process dump job step',
                dataSource,
                config
            )
            return
        }
    }
}

async function getDumpChunkBatch(
    jobId: string,
    offset: number,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<string[]> {
    const rows = await executeOperation(
        [
            {
                sql: 'SELECT content FROM tmp_export_dump_chunks WHERE job_id = ? ORDER BY chunk_index ASC LIMIT ? OFFSET ?;',
                params: [jobId, DOWNLOAD_CHUNK_BATCH_SIZE, offset],
            },
        ],
        dataSource,
        config
    )

    return rows
        .map((row: any) => row.content)
        .filter((content: unknown): content is string => typeof content === 'string')
}

export async function startDumpJobRoute(
    request: Request,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<Response> {
    try {
        await ensureDumpJobTables(dataSource, config)

        let body: Record<string, unknown> = {}
        const contentType = request.headers.get('Content-Type') || ''

        if (contentType.includes('application/json')) {
            try {
                body = (await request.json()) as Record<string, unknown>
            } catch {
                body = {}
            }
        }

        const batchSize = clampBatchSize(body.batchSize)
        const fileName =
            typeof body.fileName === 'string' && body.fileName.trim()
                ? body.fileName.trim()
                : 'database_dump.sql'

        const tableRows = await executeOperation(
            [
                {
                    sql: "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';",
                },
            ],
            dataSource,
            config
        )

        const tableNames = tableRows
            .map((row: any) => row.name)
            .filter((name: unknown): name is string => typeof name === 'string')

        const jobId = crypto.randomUUID()
        const timestamp = nowMs()

        await executeOperation(
            [
                {
                    sql: 'INSERT INTO tmp_export_dump_jobs (job_id, status, file_name, batch_size, table_index, row_offset, schema_written, chunk_index, tables_json, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0, 0, 1, ?, ?, ?);',
                    params: [
                        jobId,
                        'pending',
                        fileName,
                        batchSize,
                        JSON.stringify(tableNames),
                        timestamp,
                        timestamp,
                    ],
                },
            ],
            dataSource,
            config
        )

        await appendDumpChunk(
            jobId,
            0,
            'SQLite format 3\0',
            dataSource,
            config
        )

        return createResponse(
            {
                jobId,
                status: 'pending',
                statusPath: `/export/dump/jobs/${jobId}`,
                downloadPath: `/export/dump/jobs/${jobId}/download`,
            },
            undefined,
            202
        )
    } catch (error: any) {
        console.error('Create async dump job error:', error)
        return createResponse(undefined, 'Failed to start database dump job', 500)
    }
}

export async function getDumpJobStatusRoute(
    jobId: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<Response> {
    try {
        await ensureDumpJobTables(dataSource, config)

        await processDumpJobWithinBudget(
            jobId,
            dataSource,
            config,
            STATUS_STEP_BUDGET_MS
        )

        const job = await getDumpJobById(jobId, dataSource, config)

        if (!job) {
            return createResponse(undefined, 'Dump job not found', 404)
        }

        const chunkCount = await getDumpChunkCount(jobId, dataSource, config)

        return createResponse(
            {
                ...summarizeJob(job, chunkCount),
                statusPath: `/export/dump/jobs/${jobId}`,
                downloadPath: `/export/dump/jobs/${jobId}/download`,
            },
            undefined,
            200
        )
    } catch (error: any) {
        console.error('Async dump status error:', error)
        return createResponse(undefined, 'Failed to read dump job status', 500)
    }
}

export async function downloadDumpJobRoute(
    jobId: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<Response> {
    try {
        await ensureDumpJobTables(dataSource, config)

        const job = await getDumpJobById(jobId, dataSource, config)

        if (!job) {
            return createResponse(undefined, 'Dump job not found', 404)
        }

        if (job.status !== 'completed') {
            return createResponse(
                undefined,
                'Dump job is not completed yet',
                409
            )
        }

        const firstBatch = await getDumpChunkBatch(jobId, 0, dataSource, config)

        if (!firstBatch.length) {
            return createResponse(undefined, 'Dump content is empty', 404)
        }

        let offset = firstBatch.length
        const encoder = new TextEncoder()

        const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
                try {
                    for (const chunk of firstBatch) {
                        controller.enqueue(encoder.encode(chunk))
                    }

                    while (true) {
                        const batch = await getDumpChunkBatch(
                            jobId,
                            offset,
                            dataSource,
                            config
                        )

                        if (!batch.length) {
                            break
                        }

                        for (const chunk of batch) {
                            controller.enqueue(encoder.encode(chunk))
                        }

                        offset += batch.length
                    }

                    controller.close()
                } catch (error) {
                    console.error('Async dump download stream error:', error)
                    controller.error(error)
                }
            },
        })

        const headers = new Headers({
            'Content-Type': 'application/x-sqlite3',
            'Content-Disposition': `attachment; filename="${job.file_name}"`,
        })

        return new Response(stream, { headers })
    } catch (error: any) {
        console.error('Async dump download error:', error)
        return createResponse(undefined, 'Failed to download dump job', 500)
    }
}
