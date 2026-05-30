import { executeOperation, getTableDataChunked, createStreamingExportResponse, writeChunk } from '.'
import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { createResponse } from '../utils'

/**
 * Breathing interval between chunks (ms).
 * Allows other DO requests to be processed between export batches.
 */
const BREATHE_MS = 10

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

        if (tables.length === 0) {
            // Empty database — return header only
            return createStreamingExportResponse(
                async (writer) => {
                    await writeChunk(writer, 'SQLite format 3\0')
                },
                'database_dump.sql',
                'application/x-sqlite3'
            )
        }

        return createStreamingExportResponse(
            async (writer) => {
                // Write SQLite header
                await writeChunk(writer, 'SQLite format 3\0')

                // Iterate through all tables
                for (const table of tables) {
                    // Get table schema
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

                    if (schemaResult.length) {
                        const schema = schemaResult[0].sql
                        await writeChunk(
                            writer,
                            `\n-- Table: ${table}\n${schema};\n\n`
                        )
                    }

                    // Stream table data in chunks
                    for await (const chunk of getTableDataChunked(
                        table,
                        dataSource,
                        config,
                        1000
                    )) {
                        let batchContent = ''

                        for (const row of chunk) {
                            const values = Object.values(row).map((value) =>
                                typeof value === 'string'
                                    ? `'${value.replace(/'/g, "''")}'`
                                    : value
                            )
                            batchContent += `INSERT INTO ${table} VALUES (${values.join(', ')});\n`
                        }

                        await writeChunk(writer, batchContent)

                        // Breathing interval — let other DO requests through
                        if (BREATHE_MS > 0) {
                            await new Promise((r) =>
                                setTimeout(r, BREATHE_MS)
                            )
                        }
                    }

                    await writeChunk(writer, '\n')
                }
            },
            'database_dump.sql',
            'application/x-sqlite3'
        )
    } catch (error: any) {
        console.error('Database Dump Error:', error)
        return createResponse(undefined, 'Failed to create database dump', 500)
    }
}
