import { executeOperation } from '.'
import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { createResponse } from '../utils'

const BATCH_SIZE = 500

function escapeSqlIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`
}

function escapeSqlValue(value: unknown): string {
    if (value === null || value === undefined) {
        return 'NULL'
    }
    if (typeof value === 'number') {
        return String(value)
    }
    if (typeof value === 'boolean') {
        return value ? '1' : '0'
    }
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
        const bytes = new Uint8Array(
            value instanceof ArrayBuffer ? value : value.buffer
        )
        const hex = Array.from(bytes)
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('')
        return `X'${hex}'`
    }
    return `'${String(value).replace(/'/g, "''")}'`
}

async function* streamTableData(
    tableName: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): AsyncGenerator<string> {
    const escapedName = escapeSqlIdentifier(tableName)

    const schemaResult = await executeOperation(
        [
            {
                sql: `SELECT sql FROM sqlite_master WHERE type='table' AND name=?;`,
                params: [tableName],
            },
        ],
        dataSource,
        config
    )

    if (schemaResult.length) {
        const schema = schemaResult[0].sql
        yield `\n-- Table: ${tableName}\n${schema};\n\n`
    }

    let offset = 0
    let hasMore = true

    while (hasMore) {
        const dataResult = await executeOperation(
            [
                {
                    sql: `SELECT * FROM ${escapedName} LIMIT ? OFFSET ?;`,
                    params: [BATCH_SIZE, offset],
                },
            ],
            dataSource,
            config
        )

        if (!dataResult || dataResult.length === 0) {
            hasMore = false
            continue
        }

        for (const row of dataResult) {
            const values = Object.values(row).map((v) => escapeSqlValue(v))
            yield `INSERT INTO ${escapedName} VALUES (${values.join(', ')});\n`
        }

        if (dataResult.length < BATCH_SIZE) {
            hasMore = false
        } else {
            offset += BATCH_SIZE
        }
    }

    yield '\n'
}

function createSqlDumpStream(
    tableNames: string[],
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder()
    let tableIterator: AsyncGenerator<string> | null = null
    let tableIndex = 0
    let chunkBuffer = 'BEGIN TRANSACTION;\n'

    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                while (tableIndex < tableNames.length) {
                    if (!tableIterator) {
                        tableIterator = streamTableData(
                            tableNames[tableIndex],
                            dataSource,
                            config
                        )
                    }

                    const result = await tableIterator.next()
                    if (result.done) {
                        tableIterator = null
                        tableIndex++
                        continue
                    }

                    chunkBuffer += result.value

                    if (chunkBuffer.length >= 8192) {
                        controller.enqueue(encoder.encode(chunkBuffer))
                        chunkBuffer = ''
                        return
                    }
                }

                chunkBuffer += 'COMMIT;\n'
                if (chunkBuffer.length > 0) {
                    controller.enqueue(encoder.encode(chunkBuffer))
                    chunkBuffer = ''
                }
                controller.close()
            } catch (error: any) {
                console.error('Database Dump Stream Error:', error)
                controller.error(error)
            }
        },
    })
}

export async function dumpDatabaseRoute(
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<Response> {
    try {
        const tablesResult = await executeOperation(
            [
                {
                    sql: "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'tmp_%' ORDER BY name;",
                },
            ],
            dataSource,
            config
        )

        const tableNames = tablesResult.map((row: any) => row.name)

        const stream = createSqlDumpStream(tableNames, dataSource, config)

        const headers = new Headers({
            'Content-Type': 'text/sql',
            'Content-Disposition': `attachment; filename="database_dump.sql"`,
            'Transfer-Encoding': 'chunked',
        })

        return new Response(stream, { headers })
    } catch (error: any) {
        console.error('Database Dump Error:', error)
        return createResponse(undefined, 'Failed to create database dump', 500)
    }
}
