import { executeOperation } from '.'
import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { createResponse } from '../utils'

const DEFAULT_DUMP_BATCH_SIZE = 500

function quoteIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`
}

function toSqlHex(bytes: Uint8Array): string {
    return Array.from(bytes)
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')
}

function formatSqlValue(value: unknown): string {
    if (value === null || value === undefined) return 'NULL'
    if (typeof value === 'number') {
        return Number.isFinite(value) ? String(value) : 'NULL'
    }
    if (typeof value === 'bigint') return value.toString()
    if (typeof value === 'boolean') return value ? '1' : '0'
    if (value instanceof ArrayBuffer) {
        return `X'${toSqlHex(new Uint8Array(value))}'`
    }
    if (ArrayBuffer.isView(value)) {
        return `X'${toSqlHex(
            new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
        )}'`
    }

    return `'${String(value).replace(/'/g, "''")}'`
}

function buildInsertStatement(
    table: string,
    row: Record<string, unknown>
): string {
    const values = Object.values(row).map(formatSqlValue)
    return `INSERT INTO ${quoteIdentifier(table)} VALUES (${values.join(', ')});\n`
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
        let headerSent = false
        let tableIndex = 0
        let schemaSent = false
        let offset = 0
        const stream = new ReadableStream({
            async pull(controller) {
                try {
                    if (!headerSent) {
                        headerSent = true
                        controller.enqueue(encoder.encode('SQLite format 3\0'))
                        return
                    }

                    while (tableIndex < tables.length) {
                        const table = tables[tableIndex]

                        if (!schemaSent) {
                            schemaSent = true
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
                                return
                            }
                        }

                        const dataResult = await executeOperation(
                            [
                                {
                                    sql: `SELECT * FROM ${quoteIdentifier(table)} LIMIT ? OFFSET ?;`,
                                    params: [DEFAULT_DUMP_BATCH_SIZE, offset],
                                },
                            ],
                            dataSource,
                            config
                        )

                        if (dataResult.length) {
                            offset += DEFAULT_DUMP_BATCH_SIZE
                            const chunk = dataResult
                                .map((row: Record<string, unknown>) =>
                                    buildInsertStatement(table, row)
                                )
                                .join('')
                            controller.enqueue(encoder.encode(chunk))
                            return
                        }

                        tableIndex += 1
                        schemaSent = false
                        offset = 0
                        controller.enqueue(encoder.encode('\n'))
                        return
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
