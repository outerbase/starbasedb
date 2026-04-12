import { executeOperation } from '.'
import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { createResponse } from '../utils'

/**
 * Batch size for fetching rows from each table.
 * Keeps memory usage bounded regardless of total table size.
 */
const ROW_BATCH_SIZE = 1000

/**
 * Estimated bytes per row (conservative overestimate).
 * Used to decide when to yield control back to the event loop.
 */
const ESTIMATED_BYTES_PER_YIELD = 256 * 1024 // ~256KB

/**
 * Escape a value for SQL INSERT statements.
 */
function escapeSqlValue(value: any): string {
    if (value === null || value === undefined) return 'NULL'
    if (typeof value === 'string')
        return `'${value.replace(/'/g, "''")}'`
    if (typeof value === 'bigint') return String(value)
    return String(value)
}

/**
 * Fetch rows from a table in batches using LIMIT/OFFSET.
 * This prevents loading an entire large table into memory at once.
 */
async function* fetchRowsBatches(
    tableName: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): AsyncGenerator<any[], void, unknown> {
    let offset = 0
    while (true) {
        const batch = await executeOperation(
            [
                {
                    sql: `SELECT * FROM ${tableName} LIMIT ${ROW_BATCH_SIZE} OFFSET ${offset};`,
                },
            ],
            dataSource,
            config
        )

        if (!batch || batch.length === 0) break

        yield batch
        offset += batch.length

        // If we got fewer rows than batch size, this is the last batch
        if (batch.length < ROW_BATCH_SIZE) break
    }
}

/**
 * Cooperative yield: gives control back to the event loop so other
 * requests on this Durable Object can be processed during long exports.
 */
async function cooperativeYield(): Promise<void> {
    // Use setTimeout(0) to yield to the event loop
    await new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * Stream a database dump as a ReadableStream.
 *
 * Key improvements over the original implementation:
 * 1. **Streaming output** — uses ReadableStream so memory stays O(batch_size)
 *    instead of O(total_database_size)
 * 2. **Batched row fetching** — fetches ROW_BATCH_SIZE rows at a time via
 *    LIMIT/OFFSET instead of loading entire tables
 * 3. **Cooperative multitasking** — yields control between batches so the
 *    Durable Object remains responsive to other requests
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

        const tables: string[] = (tablesResult as any[]).map(
            (row: any) => row.name
        )

        const stream = new ReadableStream({
            async start(controller) {
                try {
                    // Write SQLite file header
                    controller.enqueue(
                        new TextEncoder().encode('SQLite format 3\0')
                    )

                    let bytesSinceLastYield = 0

                    // Iterate through all tables
                    for (const tableName of tables) {
                        // Get table schema
                        const schemaResult = await executeOperation(
                            [
                                {
                                    sql: `SELECT sql FROM sqlite_master WHERE type='table' AND name='${tableName}';`,
                                },
                            ],
                            dataSource,
                            config
                        )

                        if (
                            Array.isArray(schemaResult) &&
                            schemaResult.length > 0
                        ) {
                            const schema = schemaResult[0].sql
                            const header = `\n-- Table: ${tableName}\n${schema};\n\n`
                            const headerBytes = new TextEncoder().encode(header)
                            controller.enqueue(headerBytes)
                            bytesSinceLastYield += headerBytes.byteLength
                        }

                        // Stream data rows in batches
                        for await (const batch of fetchRowsBatches(
                            tableName,
                            dataSource,
                            config
                        )) {
                            let batchBuffer = ''
                            for (const row of batch) {
                                const values = Object.values(row).map(
                                    escapeSqlValue
                                )
                                batchBuffer += `INSERT INTO ${tableName} VALUES (${values.join(', ')});\n`
                            }

                            if (batchBuffer) {
                                const rowBytes = new TextEncoder().encode(
                                    batchBuffer
                                )
                                controller.enqueue(rowBytes)
                                bytesSinceLastYield += rowBytes.byteLength
                            }

                            // Yield control after processing enough data
                            if (bytesSinceLastYield >= ESTIMATED_BYTES_PER_YIELD) {
                                await cooperativeYield()
                                bytesSinceLastYield = 0
                            }
                        }

                        // Table separator
                        const sepBytes = new TextEncoder().encode('\n')
                        controller.enqueue(sepBytes)
                    }

                    controller.close()
                } catch (error: any) {
                    console.error('Database Dump Stream Error:', error)
                    try {
                        controller.error(error)
                    } catch (_) {
                        // Controller may already be closed
                    }
                }
            },
        })

        const headers = new Headers({
            'Content-Type': 'application/x-sqlite3',
            'Content-Disposition':
                'attachment; filename="database_dump.sql"',
        })

        return new Response(stream, { headers })
    } catch (error: any) {
        console.error('Database Dump Error:', error)
        return createResponse(undefined, 'Failed to create database dump', 500)
    }
}
