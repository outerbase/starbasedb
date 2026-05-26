/**
 * /export/dump entry points.
 *
 * Two execution paths exist behind these routes:
 *
 *   1. Legacy synchronous path (preserved for backwards compatibility):
 *      buffers the entire dump into memory and returns it inline. This still
 *      works for small databases and clients hitting GET /export/dump with
 *      the old contract.
 *
 *   2. Streaming path (new): when the DATABASE_DUMPS R2 binding is wired and
 *      the caller opts in (POST /export/dump or appends ?stream=true), the
 *      job is handed off to the Durable Object which paginates rows, flushes
 *      chunks into R2, and uses an alarm to survive past the 30-second worker
 *      limit. The response contains a jobId the client can poll until the
 *      object is fully written.
 */

import { executeOperation } from '.'
import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { createResponse } from '../utils'
import { DumpFormat, DumpJobOptions, DumpJobStatusView } from './streaming-dump'

/**
 * Legacy in-memory SQL dump. Retained for very small databases and existing
 * clients that depend on the original `GET /export/dump` contract. Internal
 * databases that exceed a few MB should use the streaming endpoint instead.
 */
export async function dumpDatabaseRoute(
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<Response> {
    try {
        // Get all table names
        const tablesResult = await executeOperation(
            [{ sql: "SELECT name FROM sqlite_master WHERE type='table';" }],
            dataSource,
            config
        )

        const tables = tablesResult.map((row: any) => row.name)
        let dumpContent = 'SQLite format 3\0' // SQLite file header

        // Iterate through all tables
        for (const table of tables) {
            // Get table schema
            const schemaResult = await executeOperation(
                [
                    {
                        sql: `SELECT sql FROM sqlite_master WHERE type='table' AND name='${table}';`,
                    },
                ],
                dataSource,
                config
            )

            if (schemaResult.length) {
                const schema = schemaResult[0].sql
                dumpContent += `\n-- Table: ${table}\n${schema};\n\n`
            }

            // Get table data
            const dataResult = await executeOperation(
                [{ sql: `SELECT * FROM ${table};` }],
                dataSource,
                config
            )

            for (const row of dataResult) {
                const values = Object.values(row).map((value) =>
                    typeof value === 'string'
                        ? `'${value.replace(/'/g, "''")}'`
                        : value
                )
                dumpContent += `INSERT INTO ${table} VALUES (${values.join(', ')});\n`
            }

            dumpContent += '\n'
        }

        // Create a Blob from the dump content
        const blob = new Blob([dumpContent], { type: 'application/x-sqlite3' })

        const headers = new Headers({
            'Content-Type': 'application/x-sqlite3',
            'Content-Disposition': 'attachment; filename="database_dump.sql"',
        })

        return new Response(blob, { headers })
    } catch (error: any) {
        console.error('Database Dump Error:', error)
        return createResponse(undefined, 'Failed to create database dump', 500)
    }
}

// -- Streaming entry points -----------------------------------------------

/** Optional body for POST /export/dump. All fields are optional. */
export interface StartDumpRequestBody {
    format?: DumpFormat
    callbackUrl?: string
    table?: string
    chunkSize?: number
}

function parseFormat(value: string | null | undefined): DumpFormat {
    const v = String(value ?? 'sql').toLowerCase()
    if (v === 'csv' || v === 'json' || v === 'sql') return v
    return 'sql'
}

/**
 * Start a streaming dump job. Returns 202 with the job descriptor. The caller
 * polls `/export/dump/status/:jobId` and downloads the finished artifact
 * from `/export/dump/download/:jobId`.
 */
export async function startStreamingDumpRoute(
    request: Request,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<Response> {
    try {
        if (dataSource.source !== 'internal' || !dataSource.rpc.startDumpJob) {
            return createResponse(
                undefined,
                'Streaming dump is only available for the internal data source.',
                400
            )
        }

        const url = new URL(request.url)
        let body: StartDumpRequestBody = {}
        if (request.method !== 'GET') {
            const contentType =
                request.headers.get('Content-Type')?.toLowerCase() ?? ''
            if (contentType.includes('application/json')) {
                try {
                    body =
                        ((await request.json()) as StartDumpRequestBody) ?? {}
                } catch {
                    return createResponse(undefined, 'Invalid JSON body.', 400)
                }
            }
        }

        const options: DumpJobOptions = {
            format: parseFormat(body.format ?? url.searchParams.get('format')),
            callbackUrl:
                body.callbackUrl ??
                url.searchParams.get('callbackUrl') ??
                undefined,
            table: body.table ?? url.searchParams.get('table') ?? undefined,
            chunkSize: body.chunkSize ?? undefined,
        }

        const status = await dataSource.rpc.startDumpJob(options)

        const baseUrl = `${url.origin}`
        const statusUrl = `${baseUrl}/export/dump/status/${status.jobId}`
        const downloadUrl = `${baseUrl}/export/dump/download/${status.jobId}`

        return new Response(
            JSON.stringify({
                result: {
                    ...status,
                    statusUrl,
                    downloadUrl,
                },
                error: undefined,
            }),
            {
                status: 202,
                headers: {
                    'Content-Type': 'application/json',
                    Location: statusUrl,
                },
            }
        )
    } catch (error: any) {
        console.error('Start streaming dump error:', error)
        return createResponse(
            undefined,
            error?.message ?? 'Failed to start dump job.',
            500
        )
    }
}

/** GET /export/dump/status/:jobId — returns the job status view. */
export async function getDumpJobStatusRoute(
    jobId: string,
    request: Request,
    dataSource: DataSource
): Promise<Response> {
    try {
        if (!dataSource.rpc.getDumpJob) {
            return createResponse(undefined, 'Not supported.', 400)
        }
        const view = (await dataSource.rpc.getDumpJob(
            jobId
        )) as DumpJobStatusView | null
        if (!view) {
            return createResponse(undefined, `Job '${jobId}' not found.`, 404)
        }
        const url = new URL(request.url)
        const downloadUrl =
            view.status === 'completed'
                ? `${url.origin}/export/dump/download/${jobId}`
                : undefined
        return new Response(
            JSON.stringify({
                result: { ...view, downloadUrl },
                error: undefined,
            }),
            {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }
        )
    } catch (error: any) {
        console.error('Get dump job status error:', error)
        return createResponse(
            undefined,
            error?.message ?? 'Failed to fetch job status.',
            500
        )
    }
}

/** GET /export/dump/download/:jobId — streams the finished file from R2. */
export async function downloadDumpJobRoute(
    jobId: string,
    dataSource: DataSource
): Promise<Response> {
    try {
        if (!dataSource.rpc.getDumpDownloadBody) {
            return createResponse(undefined, 'Not supported.', 400)
        }
        const result = (await dataSource.rpc.getDumpDownloadBody(jobId)) as {
            body: ReadableStream
            size: number
            contentType: string
            filename: string
        } | null
        if (!result) {
            return createResponse(
                undefined,
                `Dump for job '${jobId}' is not available yet.`,
                404
            )
        }
        return new Response(result.body, {
            status: 200,
            headers: {
                'Content-Type': result.contentType,
                'Content-Length': String(result.size),
                'Content-Disposition': `attachment; filename="${result.filename}"`,
            },
        })
    } catch (error: any) {
        console.error('Download dump job error:', error)
        return createResponse(
            undefined,
            error?.message ?? 'Failed to download dump.',
            500
        )
    }
}

/** DELETE /export/dump/:jobId — cancel an in-flight job. */
export async function cancelDumpJobRoute(
    jobId: string,
    dataSource: DataSource
): Promise<Response> {
    try {
        if (!dataSource.rpc.cancelDumpJob) {
            return createResponse(undefined, 'Not supported.', 400)
        }
        const view = (await dataSource.rpc.cancelDumpJob(
            jobId
        )) as DumpJobStatusView | null
        if (!view) {
            return createResponse(undefined, `Job '${jobId}' not found.`, 404)
        }
        return new Response(
            JSON.stringify({ result: view, error: undefined }),
            {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }
        )
    } catch (error: any) {
        console.error('Cancel dump job error:', error)
        return createResponse(
            undefined,
            error?.message ?? 'Failed to cancel job.',
            500
        )
    }
}
