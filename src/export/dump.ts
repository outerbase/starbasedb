import { executeOperation } from '.'
import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { createResponse } from '../utils'

/** Number of rows fetched per LIMIT/OFFSET batch. */
const BATCH_SIZE = 1_000

/**
 * Escape a column value for use inside a SQL VALUES clause.
 * Handles: null/undefined, boolean, number, string, and Uint8Array (BLOB).
 */
function escapeSqlValue(value: unknown): string {
    if (value === null || value === undefined) {
        return 'NULL'
    }
    if (typeof value === 'boolean') {
        return value ? '1' : '0'
    }
    if (typeof value === 'number') {
        return String(value)
    }
    if (value instanceof Uint8Array) {
        const hex = Array.from(value)
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('')
        return `X'${hex}'`
    }
    // Default: treat as text, escape single quotes
    return `'${String(value).replace(/'/g, "''")}'`
}

/**
 * Stream a full SQL dump of the StarbaseDB database.
 *
 * Problem (issue #59): the old implementation fetched the entire database
 * into a single string before returning a response.  This caused:
 *   - Memory exhaustion on large databases (Durable Object 1 GB cap).
 *   - Gateway timeouts (30-second hard limit before the first byte is sent).
 *
 * Solution:
 *   1. Pre-flight: collect table names & schemas *before* opening the stream
 *      so any DB error returns a clean HTTP 500 (not a broken HTTP 200).
 *   2. Stream: rows are fetched in batches of BATCH_SIZE via LIMIT/OFFSET
 *      and pushed to a ReadableStream immediately — the HTTP response starts
 *      flowing to the client as soon as the first chunk is enqueued.
 *   3. Yield: `await new Promise(r => setTimeout(r, 0))` between each batch
 *      lets the Durable Object's event loop breathe and avoids blocking.
 */
export async function dumpDatabaseRoute(
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<Response> {
    // ── Pre-flight: collect metadata before opening the stream ────────────
    // Any error here produces a clean HTTP 500 rather than a mid-stream abort.
    let tablesMeta: Array<{ name: string; schema: string }> = []

    try {
        const tablesResult = await executeOperation(
            [
                {
                    sql: `SELECT name FROM sqlite_master
                          WHERE type = 'table'
                            AND name NOT LIKE 'sqlite_%'
                          ORDER BY name;`,
                },
            ],
            dataSource,
            config
        )

        const tableNames: string[] = tablesResult.map((row: any) => row.name)

        for (const name of tableNames) {
            const schemaResult = await executeOperation(
                [
                    {
                        sql: `SELECT sql FROM sqlite_master
                              WHERE type = 'table' AND name = ?;`,
                        params: [name],
                    },
                ],
                dataSource,
                config
            )

            const schema: string =
                schemaResult.length > 0 && schemaResult[0].sql
                    ? (schemaResult[0].sql as string)
                    : ''

            tablesMeta.push({ name, schema })
        }
    } catch (error: any) {
        console.error('Database Dump Error (pre-flight):', error)
        return createResponse(undefined, 'Failed to create database dump', 500)
    }

    // ── Stream: push rows in chunks without holding them all in memory ─────
    const encoder = new TextEncoder()

    const readable = new ReadableStream<Uint8Array>({
        async start(controller) {
            const enqueue = (text: string) =>
                controller.enqueue(encoder.encode(text))

            try {
                enqueue(
                    `-- StarbaseDB SQL Dump\n-- Generated: ${new Date().toISOString()}\n\n` +
                        `PRAGMA foreign_keys = OFF;\nBEGIN TRANSACTION;\n\n`
                )

                for (const { name, schema } of tablesMeta) {
                    if (schema) {
                        enqueue(
                            `-- Table: ${name}\n` +
                                `DROP TABLE IF EXISTS \`${name}\`;\n` +
                                `${schema};\n\n`
                        )
                    }

                    // Paginate through rows in BATCH_SIZE chunks
                    let offset = 0
                    while (true) {
                        const rows = await executeOperation(
                            [
                                {
                                    sql: `SELECT * FROM \`${name}\` LIMIT ? OFFSET ?;`,
                                    params: [BATCH_SIZE, offset],
                                },
                            ],
                            dataSource,
                            config
                        )

                        if (!rows || rows.length === 0) break

                        for (const row of rows) {
                            const values = Object.values(row)
                                .map(escapeSqlValue)
                                .join(', ')
                            enqueue(`INSERT INTO \`${name}\` VALUES (${values});\n`)
                        }

                        offset += rows.length

                        // Done when last page was a partial batch
                        if (rows.length < BATCH_SIZE) break

                        // Yield event loop so the Durable Object does not stall
                        await new Promise<void>((resolve) =>
                            setTimeout(resolve, 0)
                        )
                    }

                    enqueue('\n')

                    // Yield between tables
                    await new Promise<void>((resolve) => setTimeout(resolve, 0))
                }

                enqueue('COMMIT;\n')
                controller.close()
            } catch (streamError: any) {
                console.error('Database Dump Stream Error:', streamError)
                controller.error(streamError)
            }
        },
    })

    return new Response(readable, {
        headers: new Headers({
            'Content-Type': 'application/x-sqlite3',
            'Content-Disposition': 'attachment; filename="database_dump.sql"',
            'Transfer-Encoding': 'chunked',
            'Cache-Control': 'no-store',
        }),
    })
}
