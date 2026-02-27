import {
    executeOperation,
    forEachPage,
    createStreamingExportResponse,
} from '.'
import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { createResponse } from '../utils'

export async function dumpDatabaseRoute(
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<Response> {
    try {
        // Get all table names up front (small result set).
        const tablesResult = await executeOperation(
            [{ sql: "SELECT name FROM sqlite_master WHERE type='table';" }],
            dataSource,
            config
        )

        const tables: string[] = tablesResult.map((row: any) => row.name)
        const encoder = new TextEncoder()

        const stream = new ReadableStream({
            async start(controller) {
                try {
                    controller.enqueue(
                        encoder.encode('-- StarbaseDB SQL Dump\n')
                    )
                    controller.enqueue(
                        encoder.encode(
                            `-- Generated at: ${new Date().toISOString()}\n\n`
                        )
                    )

                    for (const table of tables) {
                        // Schema (tiny query – no pagination needed)
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
                            controller.enqueue(
                                encoder.encode(
                                    `-- Table: ${table}\n${schema};\n\n`
                                )
                            )
                        }

                        // Stream row data page-by-page
                        await forEachPage(
                            table,
                            dataSource,
                            config,
                            async (rows) => {
                                let chunk = ''
                                for (const row of rows) {
                                    const values = Object.values(row).map(
                                        (value) =>
                                            value === null
                                                ? 'NULL'
                                                : typeof value === 'string'
                                                  ? `'${value.replace(/'/g, "''")}'`
                                                  : value
                                    )
                                    chunk += `INSERT INTO ${table} VALUES (${values.join(', ')});\n`
                                }
                                controller.enqueue(encoder.encode(chunk))
                            }
                        )

                        controller.enqueue(encoder.encode('\n'))
                    }

                    controller.close()
                } catch (err) {
                    controller.error(err)
                }
            },
        })

        return createStreamingExportResponse(
            stream,
            'database_dump.sql',
            'application/sql'
        )
    } catch (error: any) {
        console.error('Database Dump Error:', error)
        return createResponse(undefined, 'Failed to create database dump', 500)
    }
}
