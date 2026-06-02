import { executeOperation } from '.'
import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { createResponse } from '../utils'

/**
 * Default number of rows fetched per batch while streaming table data. Keeping the
 * working set bounded is what lets arbitrarily-large tables be dumped without loading
 * the whole database into memory.
 */
export const DEFAULT_DUMP_BATCH_SIZE = 1000

/**
 * Streams a SQL dump of the database.
 *
 * Previously the whole dump was assembled in a single in-memory string and every table
 * was read with one unbounded `SELECT *`, so large databases ran out of memory and/or
 * exceeded the 30s request window (#59). This version instead:
 *
 *  - Streams the response via a `ReadableStream`, so bytes flow to the client as they
 *    are produced (the connection stays active instead of waiting for one giant body).
 *  - Reads each table's rows in bounded batches (`LIMIT`/`OFFSET`), so memory usage stays
 *    roughly constant regardless of table size.
 *
 * The initial table-list query is performed up front so that an early failure still
 * returns a clean 500 (rather than a half-streamed 200).
 */
export async function dumpDatabaseRoute(
    dataSource: DataSource,
    config: StarbaseDBConfiguration,
    batchSize: number = DEFAULT_DUMP_BATCH_SIZE
): Promise<Response> {
    try {
        // Resolve the table list up front so early errors surface as a 500.
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
                    controller.enqueue(encoder.encode('SQLite format 3\0')) // SQLite file header

                    for (const table of tables) {
                        // Table schema
                        const schemaResult = await executeOperation(
                            [
                                {
                                    sql: `SELECT sql FROM sqlite_master WHERE type='table' AND name = ?;`,
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
                                    `\n-- Table: ${table}\n${schema};\n\n`
                                )
                            )
                        }

                        // Table data, streamed in bounded batches.
                        let offset = 0
                        while (true) {
                            const dataResult = await executeOperation(
                                [
                                    {
                                        sql: `SELECT * FROM "${table}" LIMIT ${batchSize} OFFSET ${offset};`,
                                    },
                                ],
                                dataSource,
                                config
                            )

                            if (!dataResult.length) {
                                break
                            }

                            let chunk = ''
                            for (const row of dataResult) {
                                const values = Object.values(row).map(
                                    (value) =>
                                        typeof value === 'string'
                                            ? `'${value.replace(/'/g, "''")}'`
                                            : value
                                )
                                chunk += `INSERT INTO ${table} VALUES (${values.join(', ')});\n`
                            }
                            controller.enqueue(encoder.encode(chunk))

                            if (dataResult.length < batchSize) {
                                break
                            }
                            offset += batchSize
                        }

                        controller.enqueue(encoder.encode('\n'))
                    }

                    controller.close()
                } catch (error: any) {
                    console.error('Database Dump Error (stream):', error)
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
