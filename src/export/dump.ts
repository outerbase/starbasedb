import { executeOperation } from '.'
import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { createResponse } from '../utils'

function sanitizeIdentifier(name: string): string {
    if (!/^[a-zA-Z0-9_]+$/.test(name)) {
        throw new Error(`Invalid identifier: ${name}`)
    }
    return name
}

function formatValue(value: any): string {
    if (value === null) return 'NULL'
    if (typeof value === 'number') return value.toString()
    if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`
    return `'${JSON.stringify(value).replace(/'/g, "''")}'`
}

export async function dumpDatabaseRoute(
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<Response> {
    try {
        const encoder = new TextEncoder()

        const stream = new ReadableStream({
            async start(controller) {
                try {
                    controller.enqueue(
                        encoder.encode('-- SQLite dump\nBEGIN TRANSACTION;\n')
                    )

                    const tablesResult = await executeOperation(
                        [{ sql: "SELECT name FROM sqlite_master WHERE type='table';" }],
                        dataSource,
                        config
                    )

                    const tables = tablesResult.map((row: any) => row.name)

                    for (const table of tables) {
                        const safeTable = sanitizeIdentifier(table)

                        // Get schema (safe query)
                        const schemaResult = await executeOperation(
                            [
                                {
                                    sql: "SELECT sql FROM sqlite_master WHERE type='table' AND name=?;",
                                    params: [safeTable],
                                },
                            ],
                            dataSource,
                            config
                        )

                        if (schemaResult.length) {
                            const schema = schemaResult[0].sql
                            controller.enqueue(
                                encoder.encode(
                                    `\n-- Table: ${safeTable}\n${schema};\n\n`
                                )
                            )
                        }

                        // Chunked export
                        const LIMIT = 500
                        let offset = 0

                        while (true) {
                            const dataResult = await executeOperation(
                                [
                                    {
                                        sql: `SELECT * FROM ${safeTable} LIMIT ? OFFSET ?;`,
                                        params: [LIMIT, offset],
                                    },
                                ],
                                dataSource,
                                config
                            )

                            if (!dataResult.length) break

                            for (const row of dataResult) {
                                const values = Object.values(row)
                                    .map(formatValue)
                                    .join(', ')

                                controller.enqueue(
                                    encoder.encode(
                                        `INSERT INTO ${safeTable} VALUES (${values});\n`
                                    )
                                )
                            }

                            offset += LIMIT
                        }
                    }

                    controller.enqueue(encoder.encode('\nCOMMIT;\n'))
                    controller.close()
                } catch (err) {
                    controller.error(err)
                }
            },
        })

        return new Response(stream, {
            headers: {
                'Content-Type': 'application/sql',
                'Content-Disposition': 'attachment; filename="database_dump.sql"',
            },
        })
    } catch (error: any) {
        console.error('Database Dump Error:', error)
        return createResponse(undefined, 'Failed to create database dump', 500)
    }
}