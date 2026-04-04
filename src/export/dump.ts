import { executeOperation } from '.'
import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { createResponse } from '../utils'

/** Threshold in bytes above which we switch to R2-based async dump */
const SIZE_THRESHOLD_BYTES = 10 * 1024 * 1024 // 10 MB

interface DumpJob {
    id: string
    status: 'processing' | 'completed' | 'failed'
    downloadUrl?: string
    error?: string
    createdAt: number
    completedAt?: number
}

export async function dumpDatabaseRoute(
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<Response> {
    const dumpBucket = config.dumpBucket

    // If no R2 bucket is configured, fall back to inline (current behavior)
    // This preserves backwards compatibility for users who don't need large DB dumps
    if (!dumpBucket) {
        return dumpDatabaseInline(dataSource, config)
    }

    // Check estimated database size
    try {
        const sizeResult = await executeOperation(
            [{ sql: "SELECT 0 as size WHERE 1=0; -- Get DB size hint" }],
            dataSource,
            config
        )
        // Use RPC to get actual database size if available
        const rpc = dataSource.rpc as any
        if (rpc.getStatistics) {
            const stats = await rpc.getStatistics()
            // If DB is small, use inline response
            if (stats.databaseSize < SIZE_THRESHOLD_BYTES) {
                return dumpDatabaseInline(dataSource, config)
            }
        }
    } catch {
        // If we can't determine size, try inline first
        return dumpDatabaseInline(dataSource, config)
    }

    // Large database + R2 available: use async R2-based dump
    const jobId = crypto.randomUUID()
    const objectKey = `dumps/${jobId}/database_dump.sql`

    // Store initial job state in DO storage
    const job: DumpJob = {
        id: jobId,
        status: 'processing',
        createdAt: Date.now(),
    }

    // Schedule background processing via waitUntil
    if (dataSource.executionContext) {
        dataSource.executionContext.waitUntil(
            processLargeDatabaseDump(jobId, objectKey, dataSource, config, dumpBucket)
        )
    }

    const headers = new Headers({
        'Content-Type': 'application/json',
    })

    return new Response(
        JSON.stringify({
            jobId,
            status: 'processing',
            message: 'Database dump started. This may take several minutes for large databases.',
            downloadUrl: `/export/dump/status/${jobId}`,
        }),
        { status: 202, headers }
    )
}

/**
 * Inline dump for small databases - original synchronous approach
 */
async function dumpDatabaseInline(
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

/**
 * Background processing for large database dumps using R2
 * Streams table data in chunks to avoid memory exhaustion
 */
async function processLargeDatabaseDump(
    jobId: string,
    objectKey: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration,
    dumpBucket: R2Bucket
): Promise<void> {
    const job: DumpJob = {
        id: jobId,
        status: 'processing',
        createdAt: Date.now(),
    }

    try {
        // Start building the dump content
        const tablesResult = await executeOperation(
            [{ sql: "SELECT name FROM sqlite_master WHERE type='table';" }],
            dataSource,
            config
        )

        const tables = tablesResult.map((row: any) => row.name)
        let dumpContent = 'SQLite format 3\0' // SQLite file header

        // Process each table
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

            // Get table data - process in chunks to avoid memory issues
            const CHUNK_SIZE = 1000
            let offset = 0
            let hasMoreRows = true

            while (hasMoreRows) {
                const dataResult = await executeOperation(
                    [
                        {
                            sql: `SELECT * FROM ${table} LIMIT ${CHUNK_SIZE} OFFSET ${offset};`,
                        },
                    ],
                    dataSource,
                    config
                )

                if (!dataResult || dataResult.length === 0) {
                    hasMoreRows = false
                    break
                }

                for (const row of dataResult) {
                    const values = Object.values(row).map((value) =>
                        typeof value === 'string'
                            ? `'${value.replace(/'/g, "''")}'`
                            : value
                    )
                    dumpContent += `INSERT INTO ${table} VALUES (${values.join(', ')});\n`
                }

                offset += CHUNK_SIZE

                // If we got fewer rows than chunk size, we're done with this table
                if (dataResult.length < CHUNK_SIZE) {
                    hasMoreRows = false
                }

                // Yield to event loop between chunks to prevent blocking
                await new Promise((resolve) => setTimeout(resolve, 0))
            }

            dumpContent += '\n'
        }

        // Write the complete dump to R2
        await dumpBucket.put(objectKey, dumpContent, {
            httpMetadata: {
                contentType: 'application/x-sqlite3',
            },
            customMetadata: {
                jobId,
                createdAt: new Date().toISOString(),
                tables: tables.length.toString(),
            },
        })

        job.status = 'completed'
        job.downloadUrl = `/export/dump/download/${jobId}`
        job.completedAt = Date.now()

        console.log(`Database dump completed for job ${jobId}`)
    } catch (error: any) {
        console.error(`Database dump failed for job ${jobId}:`, error)
        job.status = 'failed'
        job.error = error?.message ?? 'Unknown error'
        job.completedAt = Date.now()
    }
}
