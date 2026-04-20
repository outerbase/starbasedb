import { executeOperation } from '.'
import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { createResponse } from '../utils'
import { createExportJob, getExportJob } from './job'

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

export async function asyncDumpDatabaseRoute(
    request: Request,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<Response> {
    try {
        if (!dataSource.r2ExportBucket) {
            return createResponse(
                undefined,
                'Async exports require the EXPORT_BUCKET R2 binding to be configured',
                400
            )
        }

        let body: { async?: boolean; callbackUrl?: string; format?: string } =
            {}
        try {
            body = await request.json()
        } catch {
            body = {}
        }

        const format = (body.format as 'sql' | 'json' | 'csv') || 'sql'

        const result = await dataSource.rpc.createExportJob({
            format,
            callbackUrl: body.callbackUrl,
        })

        // Schedule the first alarm to start processing
        await dataSource.rpc.setAlarm(Date.now() + 100)

        return createResponse(
            {
                jobId: result.jobId,
                status: 'pending',
                statusUrl: result.statusUrl,
                estimatedTables: result.estimatedTables,
            },
            undefined,
            202
        )
    } catch (error: any) {
        console.error('Async Export Error:', error)
        return createResponse(
            undefined,
            error?.message || 'Failed to initiate async export',
            500
        )
    }
}

export async function getExportJobRoute(
    jobId: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<Response> {
    try {
        const job = await dataSource.rpc.getExportJob(jobId)
        if (!job) {
            return createResponse(undefined, 'Export job not found', 404)
        }

        return createResponse(
            {
                jobId: job.id,
                status: job.status,
                format: job.format,
                completedTables: job.completed_tables,
                totalTables: job.total_tables,
                bytesWritten: job.bytes_written,
                createdAt: job.created_at,
                completedAt: job.completed_at,
                errorMessage: job.error_message,
            },
            undefined,
            200
        )
    } catch (error: any) {
        console.error('Get Export Job Error:', error)
        return createResponse(
            undefined,
            error?.message || 'Failed to get export job status',
            500
        )
    }
}

export async function downloadExportJobRoute(
    jobId: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<Response> {
    try {
        const job = await dataSource.rpc.getExportJob(jobId)
        if (!job) {
            return createResponse(undefined, 'Export job not found', 404)
        }

        if (job.status !== 'completed') {
            return createResponse(
                undefined,
                `Export job is not completed. Current status: ${job.status}`,
                400
            )
        }

        const bucket = dataSource.r2ExportBucket
        if (!bucket) {
            return createResponse(
                undefined,
                'EXPORT_BUCKET not configured',
                400
            )
        }

        const object = await bucket.get(job.r2_key)
        if (!object) {
            return createResponse(
                undefined,
                'Export file not found in storage',
                404
            )
        }

        const contentType =
            job.format === 'json'
                ? 'application/json'
                : job.format === 'csv'
                  ? 'text/csv'
                  : 'application/x-sqlite3'

        const ext = job.format === 'sql' ? 'sql' : job.format
        const fileName = `export_${job.id}.${ext}`

        const headers = new Headers({
            'Content-Type': contentType,
            'Content-Disposition': `attachment; filename="${fileName}"`,
        })

        return new Response(object.body, { headers })
    } catch (error: any) {
        console.error('Download Export Job Error:', error)
        return createResponse(
            undefined,
            error?.message || 'Failed to download export',
            500
        )
    }
}
