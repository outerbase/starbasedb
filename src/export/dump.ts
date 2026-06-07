import { executeOperation } from '.'
import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { createResponse } from '../utils'
import { CHUNK_SIZE } from './constants'

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

        // Create a readable stream for progressive dump generation
        const stream = new ReadableStream({
            async start(controller) {
                try {
                    // SQLite file header
                    controller.enqueue(new TextEncoder().encode('SQLite format 3\0'))

                    for (const table of tables) {
                        // Get table schema
                        const schemaResult = await executeOperation(
                            [{ sql: `SELECT sql FROM sqlite_master WHERE type='table' AND name='${table}';` }],
                            dataSource,
                            config
                        )

                        if (schemaResult && schemaResult.length > 0) {
                            const schema = schemaResult[0].sql
                            controller.enqueue(new TextEncoder().encode(`\n-- Table: ${table}\n${schema};\n\n`))
                        }

                        // Get table data in chunks
                        let offset = 0
                        let hasMore = true

                        while (hasMore) {
                            const dataResult = await executeOperation(
                                [{ sql: `SELECT * FROM ${table} LIMIT ? OFFSET ?;`, params: [CHUNK_SIZE, offset] }],
                                dataSource,
                                config
                            )

                            if (!dataResult || dataResult.length === 0) {
                                hasMore = false
                                break
                            }

                            let chunk = ''
                            for (const row of dataResult) {
                                const values = Object.values(row).map((value: any) =>
                                    typeof value === 'string'
                                        ? `'${value.replace(/'/g, "''")}'`
                                        : value === null
                                            ? 'NULL'
                                            : value
                                )
                                chunk += `INSERT INTO ${table} VALUES (${values.join(', ')});\n`
                            }
                            controller.enqueue(new TextEncoder().encode(chunk))
                            offset += CHUNK_SIZE
                        }

                        controller.enqueue(new TextEncoder().encode('\n'))
                    }
                } catch (err: any) {
                    controller.error(err)
                    return
                }
                controller.close()
            }
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
