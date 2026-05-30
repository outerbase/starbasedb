import { executeOperation } from '.'
import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { createResponse } from '../utils'

const BATCH_SIZE = 500
const BREATHING_INTERVAL_MS = 50

function escapeValue(value: unknown): string {
    if (value === null || value === undefined) return 'NULL'
    if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`
    if (typeof value === 'number') return String(value)
    if (typeof value === 'bigint') return String(value)
    if (value instanceof ArrayBuffer || value instanceof Uint8Array) {
        const hex = Array.from(new Uint8Array(value))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('')
        return `X'${hex}'`
    }
    return `'${String(value).replace(/'/g, "''")}'`
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

async function* streamTableData(
    tableName: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): AsyncGenerator<string> {
    let offset = 0
    let hasMore = true

    while (hasMore) {
        const rows = await executeOperation(
            [
                {
                    sql: `SELECT * FROM \`${tableName}\` LIMIT ? OFFSET ?;`,
                    params: [BATCH_SIZE, offset],
                },
            ],
            dataSource,
            config
        )

        if (!rows || rows.length === 0) break

        for (const row of rows) {
            const values = Object.values(row).map(escapeValue)
            yield `INSERT INTO \`${tableName}\` VALUES (${values.join(', ')});\n`
        }

        offset += rows.length
        hasMore = rows.length === BATCH_SIZE

        // Breathing interval between batches
        if (hasMore) {
            await sleep(BREATHING_INTERVAL_MS)
        }
    }
}

export async function dumpDatabaseRoute(
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<Response> {
    try {
        // Get all table names synchronously (fail fast if DB is broken)
        const tablesResult = await executeOperation(
            [{ sql: "SELECT name FROM sqlite_master WHERE type='table';" }],
            dataSource,
            config
        )

        const tables = tablesResult.map((row: any) => row.name)

        const { readable, writable } = new TransformStream()
        const writer = writable.getWriter()
        const encoder = new TextEncoder()

        // Process tables in background (streaming)
        ;(async () => {
            try {
                // Write SQLite header
                await writer.write(encoder.encode('SQLite format 3\0'))

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
                        await writer.write(
                            encoder.encode(
                                `\n-- Table: ${table}\n${schema};\n\n`
                            )
                        )
                    }

                    // Stream table data in batches with breathing intervals
                    for await (const insertStmt of streamTableData(
                        table,
                        dataSource,
                        config
                    )) {
                        await writer.write(encoder.encode(insertStmt))
                    }

                    await writer.write(encoder.encode('\n'))
                }
            } catch (error) {
                console.error('Database Dump Stream Error:', error)
            } finally {
                await writer.close()
            }
        })()

        const headers = new Headers({
            'Content-Type': 'application/x-sqlite3',
            'Content-Disposition':
                'attachment; filename="database_dump.sql"',
            'Transfer-Encoding': 'chunked',
        })

        return new Response(readable, { headers })
    } catch (error: any) {
        console.error('Database Dump Error:', error)
        return createResponse(undefined, 'Failed to create database dump', 500)
    }
}
