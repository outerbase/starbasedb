import { executeOperation } from '.'
import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { createResponse } from '../utils'

// Number of rows to read from a table per query. Keeping this bounded means
// we never materialize an entire (potentially multi-GB) table in memory at
// once while building the dump.
const DUMP_PAGE_SIZE = 1000

export async function dumpDatabaseRoute(
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<Response> {
    try {
        // Get all table names up front so we can fail fast (with a proper 500
        // response) if the database is unreachable.
        const tablesResult = await executeOperation(
            [{ sql: "SELECT name FROM sqlite_master WHERE type='table';" }],
            dataSource,
            config
        )

        const tables = tablesResult.map((row: any) => row.name)
        const encoder = new TextEncoder()

        // Stream the dump out instead of buffering the whole database into a
        // single string. This keeps memory usage flat regardless of database
        // size, and because the response body is produced incrementally the
        // connection stays alive past the 30s request window for large dumps.
        const stream = new ReadableStream({
            async start(controller) {
                try {
                    controller.enqueue(encoder.encode('SQLite format 3\0')) // SQLite file header

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

                        // Get table data one page at a time so a single large
                        // table never has to fit in memory all at once.
                        let offset = 0
                        while (true) {
                            const dataResult = await executeOperation(
                                [
                                    {
                                        sql: `SELECT * FROM ${table} LIMIT ${DUMP_PAGE_SIZE} OFFSET ${offset};`,
                                    },
                                ],
                                dataSource,
                                config
                            )

                            for (const row of dataResult) {
                                const values = Object.values(row).map(
                                    (value) =>
                                        typeof value === 'string'
                                            ? `'${value.replace(/'/g, "''")}'`
                                            : value
                                )
                                controller.enqueue(
                                    encoder.encode(
                                        `INSERT INTO ${table} VALUES (${values.join(', ')});\n`
                                    )
                                )
                            }

                            // A short page means we've reached the end of the table.
                            if (dataResult.length < DUMP_PAGE_SIZE) {
                                break
                            }
                            offset += DUMP_PAGE_SIZE
                        }

                        controller.enqueue(encoder.encode('\n'))
                    }

                    controller.close()
                } catch (error: any) {
                    console.error('Database Dump Error:', error)
                    controller.error(error)
                }
            },
        })

        const headers = new Headers({
            'Content-Type': 'application/x-sqlite3',
            'Content-Disposition': 'attachment; filename="database_dump.sql"',
        })

        return new Response(stream, { headers })
    } catch (error: any) {
        console.error('Database Dump Error:', error)
        return createResponse(undefined, 'Failed to create database dump', 500)
    }
}
