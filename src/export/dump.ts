import { executeOperation } from '.'
import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { createResponse } from '../utils'

const BATCH_SIZE = 5000

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

                        // Get total row count
                        const countResult = await executeOperation(
                            [
                                {
                                    sql: `SELECT COUNT(*) as count FROM ${table};`,
                                },
                            ],
                            dataSource,
                            config
                        )
                        const totalRows = countResult[0]?.count ?? 0

                        // Fetch and write data in batches
                        let offset = 0
                        while (offset < totalRows) {
                            const dataResult = await executeOperation(
                                [
                                    {
                                        sql: `SELECT * FROM ${table} LIMIT ${BATCH_SIZE} OFFSET ${offset};`,
                                    },
                                ],
                                dataSource,
                                config
                            )

                            let batchContent = ''
                            for (const row of dataResult) {
                                const values = Object.values(row).map(
                                    (value) =>
                                        typeof value === 'string'
                                            ? `'${(value as string).replace(/'/g, "''")}'`
                                            : value
                                )
                                batchContent += `INSERT INTO ${table} VALUES (${values.join(', ')});\n`
                            }
                            controller.enqueue(encoder.encode(batchContent))

                            offset += BATCH_SIZE
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
            'Transfer-Encoding': 'chunked',
        })

        return new Response(stream, { headers })
    } catch (error: any) {
        console.error('Database Dump Error:', error)
        return createResponse(undefined, 'Failed to create database dump', 500)
    }
}
