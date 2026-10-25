import { executeOperation } from '.'
import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { createResponse } from '../utils'

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
                                encoder.encode(`\n-- Table: ${table}\n${schema};\n\n`)
                            )
                        }

                        // Stream table rows with cursor pagination to avoid worker OOM
                        let offset = 0
                        const chunkSize = 1000
                        while (true) {
                            const dataResult = await executeOperation(
                                [{ sql: `SELECT * FROM ${table} LIMIT ${chunkSize} OFFSET ${offset};` }],
                                dataSource,
                                config
                            )

                            if (!dataResult || dataResult.length === 0) break

                            let chunkSql = ''
                            for (const row of dataResult) {
                                const values = Object.values(row).map((value) =>
                                    typeof value === 'string'
                                        ? `'${value.replace(/'/g, "''")}'`
                                        : value
                                )
                                chunkSql += `INSERT INTO ${table} VALUES (${values.join(', ')});\n`
                            }
                            controller.enqueue(encoder.encode(chunkSql))

                            offset += dataResult.length
                            if (dataResult.length < chunkSize) break

                            // Cooperative event-loop yielding
                            await new Promise((r) => setTimeout(r, 0))
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
