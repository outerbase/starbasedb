import { executeOperation } from '.'
import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { createResponse } from '../utils'

const BATCH_SIZE = 500 // Fetch rows in batches to avoid memory spikes
const BREATHING_INTERVAL_MS = 10 // Yield control between batches

/**
 * Stream a database dump using ReadableStream to avoid OOM on large databases.
 *
 * For each table we:
 *   1. Emit the CREATE TABLE statement (schema)
 *   2. Fetch rows in batches of BATCH_SIZE using LIMIT/OFFSET
 *   3. Emit INSERT statements for each batch
 *   4. Yield control briefly between batches so other requests aren't starved
 *
 * This keeps peak memory usage proportional to BATCH_SIZE rather than the
 * entire database size, and prevents the 30-second Cloudflare Workers timeout
 * from killing the request on large databases.
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

        const tables: string[] = tablesResult.map((row: any) => row.name)

        const encoder = new TextEncoder()

        const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
                try {
                    // SQLite file header
                    controller.enqueue(encoder.encode('SQLite format 3\0'))

                    for (const table of tables) {
                        // ── Schema ──────────────────────────────────────────
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
                                    `\n-- Table: ${table}\n${schema};\n\n`
                                )
                            )
                        }

                        // ── Data (streamed in batches) ──────────────────────
                        let offset = 0
                        let hasMore = true

                        while (hasMore) {
                            const dataResult = await executeOperation(
                                [
                                    {
                                        sql: `SELECT * FROM ${escapeIdent(table)} LIMIT ? OFFSET ?;`,
                                        params: [BATCH_SIZE, offset],
                                    },
                                ],
                                dataSource,
                                config
                            )

                            if (!dataResult || dataResult.length === 0) {
                                hasMore = false
                                break
                            }

                            // Build INSERT statements for this batch
                            const batchLines: string[] = []
                            for (const row of dataResult) {
                                const values = Object.values(row).map((value) =>
                                    escapeValue(value)
                                )
                                batchLines.push(
                                    `INSERT INTO ${escapeIdent(table)} VALUES (${values.join(', ')});`
                                )
                            }
                            controller.enqueue(
                                encoder.encode(batchLines.join('\n') + '\n')
                            )

                            offset += dataResult.length

                            // If we got fewer rows than requested, we're done
                            if (dataResult.length < BATCH_SIZE) {
                                hasMore = false
                            }

                            // Breathing interval – yield to the event loop so
                            // other in-flight requests can be served.
                            await sleep(BREATHING_INTERVAL_MS)
                        }

                        controller.enqueue(encoder.encode('\n'))
                    }

                    controller.close()
                } catch (err) {
                    controller.error(err)
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

// ── Helpers ────────────────────────────────────────────────────────────────

/** Escape a SQL identifier (table/column name) – very basic but sufficient for generated code. */
function escapeIdent(name: string): string {
    return `"${name.replace(/"/g, '""')}"`
}

/** Format a JS value as a SQL literal. */
function escapeValue(value: unknown): string {
    if (value === null || value === undefined) {
        return 'NULL'
    }
    if (typeof value === 'string') {
        return `'${value.replace(/'/g, "''")}'`
    }
    if (typeof value === 'number' || typeof value === 'bigint') {
        return String(value)
    }
    if (typeof value === 'boolean') {
        return value ? '1' : '0'
    }
    // ArrayBuffer / Uint8Array → hex blob literal
    if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
        const bytes =
            value instanceof ArrayBuffer ? new Uint8Array(value) : value
        const hex = Array.from(bytes)
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('')
        return `X'${hex}'`
    }
    // Fallback: stringify as quoted text
    return `'${String(value).replace(/'/g, "''")}'`
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}
