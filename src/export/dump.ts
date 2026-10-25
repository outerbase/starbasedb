import { executeOperation } from '.'
import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { createResponse } from '../utils'

const CHUNK_SIZE = 1000

function formatSqlValue(value: unknown): string {
    if (value === null || value === undefined) {
        return 'NULL'
    }
    if (typeof value === 'string') {
        return `'${value.replace(/'/g, "''")}'`
    }
    if (typeof value === 'boolean') {
        return value ? '1' : '0'
    }
    return String(value)
}

export async function dumpDatabaseRoute(
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<Response> {
    try {
        // Get all table names up front
        const tablesResult = await executeOperation(
            [{ sql: "SELECT name FROM sqlite_master WHERE type='table';" }],
            dataSource,
            config
        )

        const tables = (tablesResult as Array<{ name: string }>).map(
            (row) => row.name
        )

        const encoder = new TextEncoder()
        const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
                try {
                    // SQLite file header
                    controller.enqueue(encoder.encode('SQLite format 3\0'))

                    // Iterate through all tables
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

                        if (schemaResult && schemaResult.length) {
                            const schema = schemaResult[0].sql
                            controller.enqueue(
                                encoder.encode(
                                    `\n-- Table: ${table}\n${schema};\n\n`
                                )
                            )
                        }

                        // Stream table data in paginated batches
                        let offset = 0
                        while (true) {
                            const dataResult = await executeOperation(
                                [
                                    {
                                        sql: `SELECT * FROM ${table} LIMIT ${CHUNK_SIZE} OFFSET ${offset};`,
                                    },
                                ],
                                dataSource,
                                config
                            )

                            if (!dataResult || dataResult.length === 0) {
                                break
                            }

                            let chunkSql = ''
                            for (const row of dataResult) {
                                const values =
                                    Object.values(row).map(formatSqlValue)
                                chunkSql += `INSERT INTO ${table} VALUES (${values.join(', ')});\n`
                            }
                            controller.enqueue(encoder.encode(chunkSql))

                            offset += dataResult.length
                            if (dataResult.length < CHUNK_SIZE) {
                                break
                            }
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
