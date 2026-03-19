import {
    createStreamingExportResponse,
    executeOperation,
    forEachPage,
    quoteIdentifier,
} from '.'
import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { createResponse } from '../utils'

const encoder = new TextEncoder()

function toSqlLiteral(value: unknown): string {
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

    return `'${JSON.stringify(value).replace(/'/g, "''")}'`
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

        const tables = tablesResult
            .map((row: any) => row.name)
            .filter((table: string) => !table.startsWith('tmp_'))

        const stream = new ReadableStream<Uint8Array>({
            start: async (controller) => {
                try {
                    controller.enqueue(encoder.encode('SQLite format 3\0'))

                    for (const table of tables) {
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

                        if (!schemaResult.length) {
                            continue
                        }

                        const schema = schemaResult[0].sql
                        controller.enqueue(
                            encoder.encode(
                                `\n-- Table: ${table}\n${schema};\n\n`
                            )
                        )

                        await forEachPage(
                            table,
                            dataSource,
                            config,
                            1000,
                            (rows) => {
                                const quotedTableName = quoteIdentifier(table)
                                for (const row of rows) {
                                    const values = Object.values(row).map(
                                        (value) => toSqlLiteral(value)
                                    )
                                    controller.enqueue(
                                        encoder.encode(
                                            `INSERT INTO ${quotedTableName} VALUES (${values.join(', ')});\n`
                                        )
                                    )
                                }
                            }
                        )

                        controller.enqueue(encoder.encode('\n'))
                    }

                    controller.close()
                } catch (error) {
                    controller.error(error)
                }
            },
        })

        return createStreamingExportResponse(
            stream,
            'database_dump.sql',
            'application/x-sqlite3'
        )
    } catch (error: any) {
        console.error('Database Dump Error:', error)
        return createResponse(undefined, 'Failed to create database dump', 500)
    }
}
