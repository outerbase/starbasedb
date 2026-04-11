import {
    executeOperation,
    getTableDataChunked,
    createStreamingExportResponse,
    CHUNK_SIZE,
} from '.'
import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { createResponse } from '../utils'

/**
 * Format a single value for a SQL INSERT statement.
 * Handles strings (with quote escaping), nulls, binary data (as hex),
 * and numeric types.
 */
function formatSqlValue(value: unknown): string {
    if (value === null || value === undefined) {
        return 'NULL'
    }

    if (value instanceof ArrayBuffer || value instanceof Uint8Array) {
        const bytes =
            value instanceof ArrayBuffer ? new Uint8Array(value) : value
        const hex = Array.from(bytes)
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('')
        return `X'${hex}'`
    }

    if (typeof value === 'string') {
        return `'${value.replace(/'/g, "''")}'`
    }

    return String(value)
}

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

        const encoder = new TextEncoder()
        const stream = new ReadableStream({
            async start(controller) {
                try {
                    // Write SQLite header
                    controller.enqueue(encoder.encode('SQLite format 3\0'))

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
                            controller.enqueue(
                                encoder.encode(
                                    `\n-- Table: ${table}\n${schema};\n\n`
                                )
                            )
                        }

                        // Stream table data in chunks using LIMIT/OFFSET
                        let offset = 0
                        while (true) {
                            const rows = await getTableDataChunked(
                                table,
                                offset,
                                CHUNK_SIZE,
                                dataSource,
                                config
                            )

                            if (!rows || rows.length === 0) {
                                break
                            }

                            let chunk = ''
                            for (const row of rows) {
                                const values =
                                    Object.values(row).map(formatSqlValue)
                                chunk += `INSERT INTO ${table} VALUES (${values.join(', ')});\n`
                            }
                            controller.enqueue(encoder.encode(chunk))

                            // If we got fewer rows than the chunk size, we've
                            // reached the end of the table
                            if (rows.length < CHUNK_SIZE) {
                                break
                            }

                            offset += CHUNK_SIZE
                        }

                        controller.enqueue(encoder.encode('\n'))
                    }

                    controller.close()
                } catch (error) {
                    controller.error(error)
                }
            },
        })

        return createStreamingExportResponse(
            stream,
            'database_dump.sql',
            'application/x-sqlite3'
        )
    } catch (error: any) {
        console.error('Database Dump Error:', error)
        return createResponse(undefined, 'Failed to create database dump', 500)
    }
}
