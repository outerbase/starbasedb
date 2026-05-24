import { executeOperation } from '.'
import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { createResponse } from '../utils'

// Number of rows fetched per page when dumping a table. Keeping this
// bounded avoids loading entire tables into Worker memory, which is
// what previously caused dumps of large databases to fail.
const DUMP_PAGE_SIZE = 1000

function formatValue(value: unknown): string {
    if (value === null || value === undefined) return 'NULL'
    if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`
    return String(value)
}

export async function dumpDatabaseRoute(
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<Response> {
    try {
        // Resolve the list of tables up front so any failure surfaces as a
        // 500 (matching prior behavior) rather than mid-stream.
        const tablesResult = await executeOperation(
            [{ sql: "SELECT name FROM sqlite_master WHERE type='table';" }],
            dataSource,
            config
        )
        const tables = tablesResult.map((row: any) => row.name)

        const encoder = new TextEncoder()
        const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
                try {
                    controller.enqueue(encoder.encode('SQLite format 3\0'))

                    for (const table of tables) {
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

                        // Page through the table so we never materialize the
                        // full result set in memory.
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

                            if (!dataResult.length) break

                            let chunk = ''
                            for (const row of dataResult) {
                                const values =
                                    Object.values(row).map(formatValue)
                                chunk += `INSERT INTO ${table} VALUES (${values.join(', ')});\n`
                            }
                            controller.enqueue(encoder.encode(chunk))

                            if (dataResult.length < DUMP_PAGE_SIZE) break
                            offset += DUMP_PAGE_SIZE
                        }

                        controller.enqueue(encoder.encode('\n'))
                    }

                    controller.close()
                } catch (error) {
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
