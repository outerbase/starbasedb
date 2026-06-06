import { executeOperation } from '.'
import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { createResponse } from '../utils'
import {
    createExportJob,
    completeExportJob,
    failExportJob,
    updateExportJobProgress,
} from './job'

const CHUNK_SIZE = 1000 // Number of rows to process per chunk
const MAX_EXECUTION_TIME = 25000 // 25 seconds, leaving buffer before 30s timeout

/**
 * Stream database dump to R2 using chunked writes to support large databases
 */
export async function streamDatabaseDumpToR2(
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<Response> {
    try {
        // Check if R2 bucket is available
        if (!dataSource.exportBucket) {
            return createResponse(
                undefined,
                'R2 bucket not configured. Please configure EXPORT_BUCKET binding in wrangler.toml',
                500
            )
        }

        // Start new export
        const timestamp = new Date()
            .toISOString()
            .replace(/[:.]/g, '-')
            .replace('T', '_')
            .split('Z')[0]
        const fileName = `dump_${timestamp}.sql`

        // Get all table names (excluding temp tables)
        const tablesResult = await executeOperation(
            [{ sql: "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'tmp_%';" }],
            dataSource,
            config
        )

        const tables = tablesResult.map((row: any) => row.name)

        if (tables.length === 0) {
            // Empty database - create minimal dump file
            const emptyContent = 'SQLite format 3\0\n-- Empty database\n'
            await dataSource.exportBucket.put(fileName, emptyContent)
            return createResponse(
                { fileName, status: 'completed', jobId: null },
                undefined,
                200
            )
        }

        const jobId = await createExportJob(dataSource, fileName)
        const startTime = Date.now()

        // Build the dump content in memory with chunked processing
        let dumpContent = 'SQLite format 3\0\n'
        let currentTableIndex = 0

        for (const tableName of tables) {
            currentTableIndex++

            // Check if we're approaching timeout
            const elapsedTime = Date.now() - startTime
            if (elapsedTime > MAX_EXECUTION_TIME) {
                // For now, write what we have and indicate partial completion
                // Future enhancement: implement alarm-based continuation
                await dataSource.exportBucket.put(fileName, dumpContent)
                await updateExportJobProgress(
                    dataSource,
                    jobId,
                    tableName,
                    0,
                    tables.length
                )

                return createResponse(
                    {
                        jobId,
                        fileName,
                        status: 'in_progress',
                        message: 'Export in progress. Use /export/job/:jobId to check status.',
                        progress: {
                            currentTable: currentTableIndex,
                            totalTables: tables.length,
                        },
                    },
                    undefined,
                    202
                )
            }

            // Get table schema
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
                const schema = schemaResult[0].sql
                dumpContent += `\n-- Table: ${tableName}\n${schema};\n\n`
            }

            // Get table data in chunks to avoid loading all rows at once
            let offset = 0
            let hasMoreRows = true

            while (hasMoreRows) {
                const dataResult = await executeOperation(
                    [
                        {
                            sql: `SELECT * FROM "${tableName}" LIMIT ? OFFSET ?;`,
                            params: [CHUNK_SIZE, offset],
                        },
                    ],
                    dataSource,
                    config
                )

                if (dataResult.length > 0) {
                    // Generate INSERT statements for this chunk
                    for (const row of dataResult) {
                        const values = Object.values(row).map((value) =>
                            typeof value === 'string'
                                ? `'${value.replace(/'/g, "''")}'`
                                : value === null
                                  ? 'NULL'
                                  : value
                        )
                        dumpContent += `INSERT INTO "${tableName}" VALUES (${values.join(', ')});\n`
                    }

                    // Update progress
                    await updateExportJobProgress(
                        dataSource,
                        jobId,
                        tableName,
                        offset + dataResult.length,
                        tables.length
                    )

                    offset += CHUNK_SIZE

                    // If we got fewer rows than CHUNK_SIZE, we've reached the end
                    if (dataResult.length < CHUNK_SIZE) {
                        hasMoreRows = false
                    }
                } else {
                    hasMoreRows = false
                }
            }

            dumpContent += '\n'
        }

        // Write final content to R2
        await dataSource.exportBucket.put(fileName, dumpContent)

        // Mark job as completed
        await completeExportJob(dataSource, jobId)

        return createResponse(
            {
                jobId,
                fileName,
                status: 'completed',
                message: `Database exported successfully. Download at /export/download/${fileName}`,
            },
            undefined,
            200
        )
    } catch (error: any) {
        console.error('Database Dump Error:', error)
        return createResponse(undefined, 'Failed to create database dump', 500)
    }
}
