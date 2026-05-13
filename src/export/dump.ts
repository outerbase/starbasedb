import {
    executeOperation,
    EXPORT_PAGE_SIZE,
    getTableDataPage,
    quoteIdentifier,
} from '.'
import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { createResponse } from '../utils'

function serializeSqlValue(value: unknown): string {
    if (value === null || value === undefined) {
        return 'NULL'
    }

    if (typeof value === 'string') {
        return `'${value.replace(/'/g, "''")}'`
    }

    if (typeof value === 'boolean') {
        return value ? '1' : '0'
    }

    if (value instanceof Uint8Array) {
        return `X'${Array.from(value)
            .map((byte) => byte.toString(16).padStart(2, '0'))
            .join('')}'`
    }

    return String(value)
}

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
                controller.enqueue(encoder.encode('SQLite format 3\0'))

                for (const table of tables) {
                    const quotedTable = quoteIdentifier(table)

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

                    let offset = 0
                    let hasMoreRows = true

                    while (hasMoreRows) {
                        const dataResult = await getTableDataPage(
                            table,
                            offset,
                            dataSource,
                            config
                        )

                        for (const row of dataResult) {
                            const values = Object.values(row).map((value) =>
                                serializeSqlValue(value)
                            )
                            controller.enqueue(
                                encoder.encode(
                                    `INSERT INTO ${quotedTable} VALUES (${values.join(', ')});\n`
                                )
                            )
                        }

                        hasMoreRows = dataResult.length === EXPORT_PAGE_SIZE
                        offset += EXPORT_PAGE_SIZE

                        if (hasMoreRows) {
                            await new Promise((resolve) =>
                                setTimeout(resolve, 0)
                            )
                        }
                    }

                    controller.enqueue(encoder.encode('\n'))
                }

                controller.close()
            },
            cancel() {
                // Client disconnected; stop producing dump chunks.
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
