import { executeOperation } from '.'
import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { createResponse } from '../utils'

/**
 * Batch size for paginated row reads. Keeping it at 1000 rows per query
 * avoids large per-query allocations while still being efficient.
 */
const BATCH_SIZE = 1_000

/**
 * Yield to the event loop so other pending micro-tasks (e.g. inbound requests
 * to the Durable Object) can run between batches. Without this the DO can lock
 * up under load while an export is in progress.
 */
function breathe(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * Escape a SQL identifier (table / column name) by wrapping it in double
 * quotes and doubling any embedded double-quote characters.
 */
function quoteIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`
}

/**
 * Produce a SQL literal for an arbitrary row value.
 * - strings  →  single-quoted with internal quotes doubled
 * - null      →  NULL
 * - boolean   →  1 / 0
 * - everything else → raw value (numbers, bigint …)
 */
function sqlValue(value: unknown): string {
    if (value === null || value === undefined) return 'NULL'
    if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`
    if (typeof value === 'boolean') return value ? '1' : '0'
    return String(value)
}

/**
 * Stream a full SQL dump of the database.
 *
 * Key improvements over the original implementation:
 *   1. Uses a ReadableStream so bytes are flushed to the client as they are
 *      produced rather than accumulated in a single in-memory string.
 *   2. Reads each table in paginated batches (LIMIT/OFFSET) so a single large
 *      table never occupies more than BATCH_SIZE rows in memory at once.
 *   3. Calls `breathe()` between batches to yield the event loop and prevent
 *      the Durable Object from blocking other incoming requests.
 *   4. Uses parameterised queries / quoted identifiers everywhere to avoid
 *      SQL-injection in table / column names that contain special characters.
 */
export async function dumpDatabaseRoute(
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<Response> {
    try {
        const tablesResult = await executeOperation(
            [
                {
                    sql: "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;",
                },
            ],
            dataSource,
            config
        )

        const tables: string[] = tablesResult.map((row: any) => row.name)

        const encoder = new TextEncoder()

        const stream = new ReadableStream({
            async start(controller) {
                try {
                    // Write the conventional SQL dump header comment so consumers
                    // know this is a plain-text SQL script, not a binary SQLite file.
                    controller.enqueue(
                        encoder.encode(
                            '-- StarbaseDB SQL dump\n-- Generated: ' +
                                new Date().toISOString() +
                                '\n\nBEGIN TRANSACTION;\n\n'
                        )
                    )

                    for (const table of tables) {
                        // --- Schema ---
                        const schemaResult = await executeOperation(
                            [
                                {
                                    sql: 'SELECT sql FROM sqlite_master WHERE type=? AND name=?;',
                                    params: ['table', table],
                                },
                            ],
                            dataSource,
                            config
                        )

                        if (schemaResult.length && schemaResult[0].sql) {
                            const ddl: string = schemaResult[0].sql
                            controller.enqueue(
                                encoder.encode(
                                    `-- Table: ${table}\n${ddl};\n\n`
                                )
                            )
                        }

                        // --- Data (paginated) ---
                        let offset = 0
                        while (true) {
                            const rows = await executeOperation(
                                [
                                    {
                                        sql: `SELECT * FROM ${quoteIdentifier(table)} LIMIT ? OFFSET ?;`,
                                        params: [BATCH_SIZE, offset],
                                    },
                                ],
                                dataSource,
                                config
                            )

                            if (!rows || rows.length === 0) break

                            for (const row of rows) {
                                const values = Object.values(row).map(sqlValue)
                                controller.enqueue(
                                    encoder.encode(
                                        `INSERT INTO ${quoteIdentifier(table)} VALUES (${values.join(', ')});\n`
                                    )
                                )
                            }

                            offset += rows.length

                            // Yield to the event loop after each batch so
                            // other DO requests can be serviced.
                            await breathe()

                            // If we received fewer rows than the batch size we
                            // have reached the end of the table.
                            if (rows.length < BATCH_SIZE) break
                        }

                        controller.enqueue(encoder.encode('\n'))

                        // Yield between tables as well.
                        await breathe()
                    }

                    controller.enqueue(encoder.encode('COMMIT;\n'))
                    controller.close()
                } catch (innerError: any) {
                    console.error('Database Dump Stream Error:', innerError)
                    controller.error(innerError)
                }
            },
        })

        const headers = new Headers({
            'Content-Type': 'application/x-sqlite3',
            'Content-Disposition': 'attachment; filename="database_dump.sql"',
            'Transfer-Encoding': 'chunked',
        })

        return new Response(stream, { headers })
    } catch (error: any) {
        console.error('Database Dump Error:', error)
        return createResponse(undefined, 'Failed to create database dump', 500)
    }
}
