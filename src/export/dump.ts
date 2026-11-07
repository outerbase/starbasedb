import { executeOperation } from '.'
import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { createResponse } from '../utils'

// Minimal interface for Cloudflare R2 bucket bindings used during large database exports.
export interface R2DumpBucket {
    put: (
        key: string,
        value: string | ArrayBuffer | Blob
    ) => Promise<unknown>
    get?: (key: string) => Promise<{ text: () => Promise<string> } | null>
}

// Options controlling chunked pagination, breathing intervals, R2 persistence, and webhook callbacks.
export interface DumpDatabaseOptions {
    batchSize?: number
    breathingIntervalMs?: number
    maxExecutionMs?: number
    r2Bucket?: R2DumpBucket
    callbackUrl?: string
    jobId?: string
    fileName?: string
    now?: Date
}

export interface DumpExecutionContext {
    dataSource: DataSource
    config: StarbaseDBConfiguration
    options?: DumpDatabaseOptions
}

interface TableExportCursor {
    tableIndex: number
    rowOffset: number
    fileName: string
    accumulatedContent: string
}

const EXPORT_JOB_SQL = {
    CREATE_TABLE: `
        CREATE TABLE IF NOT EXISTS tmp_export_jobs (
            job_id TEXT NOT NULL UNIQUE PRIMARY KEY,
            file_name TEXT NOT NULL,
            table_index INTEGER NOT NULL DEFAULT 0,
            row_offset INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'in_progress',
            callback_url TEXT,
            updated_at INTEGER NOT NULL
        )
    `,
    UPSERT_JOB: `
        INSERT OR REPLACE INTO tmp_export_jobs (
            job_id,
            file_name,
            table_index,
            row_offset,
            status,
            callback_url,
            updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
}

// Formats a UTC timestamp into the R2 backup filename convention dump_YYYYMMDD-HHMMSS.sql.
export function formatDumpFilename(date: Date = new Date()): string {
    const pad = (n: number) => String(n).padStart(2, '0')
    const datePart = `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`
    const timePart = `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
    return `dump_${datePart}-${timePart}.sql`
}

// Formats a single database row into a SQLite INSERT statement with escaped string literals.
export function formatInsertStatement(
    table: string,
    row: Record<string, unknown>
): string {
    const values = Object.values(row).map((value) =>
        typeof value === 'string' ? `'${value.replace(/'/g, "''")}'` : value
    )
    return `INSERT INTO ${table} VALUES (${values.join(', ')});\n`
}

// Yields execution between synchronous Durable Object SQL batches so queued requests can interleave.
async function pauseForBreathingInterval(intervalMs?: number): Promise<void> {
    if (!intervalMs) return
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
}

// Fetches a single page of table rows, using unpaginated SELECT when batchSize is not constrained.
async function fetchTableBatch(
    ctx: DumpExecutionContext,
    querySpec: { table: string; offset: number }
): Promise<Record<string, unknown>[]> {
    const batchSize = ctx.options?.batchSize
    const sql = batchSize
        ? `SELECT * FROM ${querySpec.table} LIMIT ${batchSize} OFFSET ${querySpec.offset};`
        : `SELECT * FROM ${querySpec.table};`

    return (await executeOperation(
        [{ sql }],
        ctx.dataSource,
        ctx.config
    )) as Record<string, unknown>[]
}

// Appends table CREATE statement to the dump stream when starting at offset 0.
async function fetchTableSchemaHeader(
    ctx: DumpExecutionContext,
    table: string
): Promise<string> {
    const schemaResult = await executeOperation(
        [
            {
                sql: `SELECT sql FROM sqlite_master WHERE type='table' AND name='${table}';`,
            },
        ],
        ctx.dataSource,
        ctx.config
    )
    if (!schemaResult.length) return ''
    return `\n-- Table: ${table}\n${schemaResult[0].sql};\n\n`
}

// Persists checkpoint state and schedules a Durable Object alarm when an export exceeds maxExecutionMs.
async function persistCheckpointAndScheduleAlarm(
    ctx: DumpExecutionContext,
    cursor: TableExportCursor
): Promise<Response> {
    const jobId = ctx.options?.jobId ?? cursor.fileName
    await ctx.options?.r2Bucket?.put(cursor.fileName, cursor.accumulatedContent)
    await executeOperation(
        [
            { sql: EXPORT_JOB_SQL.CREATE_TABLE },
            {
                sql: EXPORT_JOB_SQL.UPSERT_JOB,
                params: [
                    jobId,
                    cursor.fileName,
                    cursor.tableIndex,
                    cursor.rowOffset,
                    'in_progress',
                    ctx.options?.callbackUrl ?? null,
                    Date.now(),
                ],
            },
        ],
        ctx.dataSource,
        ctx.config
    )
    await ctx.dataSource.rpc?.setAlarm?.(Date.now() + 5000)
    return createResponse(
        {
            jobId,
            fileName: cursor.fileName,
            status: 'in_progress',
            tableIndex: cursor.tableIndex,
            rowOffset: cursor.rowOffset,
        },
        undefined,
        202
    )
}

// Sends a completion webhook notification and writes the final SQL dump to R2 if configured.
async function finalizeDumpDelivery(
    ctx: DumpExecutionContext,
    result: { fileName: string; content: string; tablesExported: number }
): Promise<void> {
    await ctx.options?.r2Bucket?.put(result.fileName, result.content)
    const callbackUrl = ctx.options?.callbackUrl
    if (!callbackUrl) return

    await fetch(callbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            fileName: result.fileName,
            status: 'completed',
            tablesExported: result.tablesExported,
            completedAt: new Date().toISOString(),
        }),
    })
}

// Checks whether the current export invocation has exhausted its wall-clock time budget.
function hasExecutionBudgetExpired(
    startTime: number,
    maxExecutionMs?: number
): boolean {
    if (!maxExecutionMs) return false
    return Date.now() - startTime >= maxExecutionMs
}

// Determines whether another paginated SQL batch must be fetched for the current table.
function hasMoreTablePages(fetchedRows: number, batchSize?: number): boolean {
    if (!batchSize) return false
    return fetchedRows >= batchSize
}

// Exports a single table across one or more paginated batches, returning early if the execution budget expires.
async function exportSingleTable(
    ctx: DumpExecutionContext,
    state: {
        table: string
        tableIndex: number
        startTime: number
        cursor: TableExportCursor
    }
): Promise<boolean> {
    const { table, tableIndex, startTime, cursor } = state
    cursor.accumulatedContent += await fetchTableSchemaHeader(ctx, table)

    let offset = 0
    let shouldContinue = true

    while (shouldContinue) {
        if (hasExecutionBudgetExpired(startTime, ctx.options?.maxExecutionMs)) {
            cursor.tableIndex = tableIndex
            cursor.rowOffset = offset
            return true
        }

        const rows = await fetchTableBatch(ctx, { table, offset })
        cursor.accumulatedContent += rows
            .map((row) => formatInsertStatement(table, row))
            .join('')
        await pauseForBreathingInterval(ctx.options?.breathingIntervalMs)

        shouldContinue = hasMoreTablePages(rows.length, ctx.options?.batchSize)
        offset += rows.length
    }

    cursor.accumulatedContent += '\n'
    return false
}

// Builds the HTTP attachment Response containing the SQLite SQL dump payload.
function buildSqliteDumpResponse(dumpContent: string): Response {
    const blob = new Blob([dumpContent], { type: 'application/x-sqlite3' })
    const headers = new Headers({
        'Content-Type': 'application/x-sqlite3',
        'Content-Disposition': 'attachment; filename="database_dump.sql"',
    })
    return new Response(blob, { headers })
}

// Executes a full or resumable database dump with optional chunked pagination, R2 storage, and webhook callback.
export async function dumpDatabaseWithOptions(
    ctx: DumpExecutionContext
): Promise<Response> {
    try {
        const startTime = Date.now()
        const tablesResult = await executeOperation(
            [{ sql: "SELECT name FROM sqlite_master WHERE type='table';" }],
            ctx.dataSource,
            ctx.config
        )

        const tables = tablesResult.map((row: any) => row.name)
        const fileName =
            ctx.options?.fileName ?? formatDumpFilename(ctx.options?.now)
        const cursor: TableExportCursor = {
            tableIndex: 0,
            rowOffset: 0,
            fileName,
            accumulatedContent: 'SQLite format 3\0',
        }

        for (let idx = 0; idx < tables.length; idx++) {
            const timedOut = await exportSingleTable(ctx, {
                table: tables[idx],
                tableIndex: idx,
                startTime,
                cursor,
            })
            if (timedOut) {
                return persistCheckpointAndScheduleAlarm(ctx, cursor)
            }
        }

        await finalizeDumpDelivery(ctx, {
            fileName: cursor.fileName,
            content: cursor.accumulatedContent,
            tablesExported: tables.length,
        })

        return buildSqliteDumpResponse(cursor.accumulatedContent)
    } catch (error: any) {
        console.error('Database Dump Error:', error)
        return createResponse(undefined, 'Failed to create database dump', 500)
    }
}

export async function dumpDatabaseRoute(
    dataSource: DataSource,
    config: StarbaseDBConfiguration & { dumpOptions?: DumpDatabaseOptions }
): Promise<Response> {
    return dumpDatabaseWithOptions({
        dataSource,
        config,
        options: config?.dumpOptions,
    })
}
