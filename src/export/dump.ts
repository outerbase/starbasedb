import { executeOperation } from '.'
import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { createResponse } from '../utils'

const DEFAULT_EXPORT_BATCH_SIZE = 500

function quoteIdentifier(identifier: string) {
    return `"${identifier.replace(/"/g, '""')}"`
}

function formatSqlValue(value: unknown) {
    if (value === null || value === undefined) {
        return 'NULL'
    }

    if (typeof value === 'string') {
        return `'${value.replace(/'/g, "''")}'`
    }

    if (typeof value === 'boolean') {
        return value ? '1' : '0'
    }

    if (value instanceof ArrayBuffer) {
        return `X'${arrayBufferToHex(value)}'`
    }

    if (ArrayBuffer.isView(value)) {
        const view = value as ArrayBufferView
        return `X'${arrayBufferToHex(
            view.buffer.slice(
                view.byteOffset,
                view.byteOffset + view.byteLength
            )
        )}'`
    }

    return String(value)
}

function arrayBufferToHex(value: ArrayBuffer) {
    return Array.from(new Uint8Array(value))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')
}

async function pauseForQueuedWork() {
    await new Promise((resolve) => setTimeout(resolve, 0))
}

async function enqueueDatabaseDump(
    controller: ReadableStreamDefaultController<Uint8Array>,
    encoder: TextEncoder,
    tables: string[],
    dataSource: DataSource,
    config: StarbaseDBConfiguration,
    batchSize = DEFAULT_EXPORT_BATCH_SIZE
) {
    const enqueue = (chunk: string) => controller.enqueue(encoder.encode(chunk))

    enqueue('SQLite format 3\0')

    for (const table of tables) {
        const quotedTable = quoteIdentifier(table)
        const schemaResult = await executeOperation(
            [
                {
                    sql: "SELECT sql FROM sqlite_master WHERE type='table' AND name=?;",
                    params: [table],
                },
            ],
            dataSource,
            config
        )

        if (schemaResult.length) {
            const schema = schemaResult[0].sql
            enqueue(`\n-- Table: ${table}\n${schema};\n\n`)
        }

        for (let offset = 0; ; offset += batchSize) {
            const rows = await executeOperation(
                [
                    {
                        sql: `SELECT * FROM ${quotedTable} LIMIT ? OFFSET ?;`,
                        params: [batchSize, offset],
                    },
                ],
                dataSource,
                config
            )

            for (const row of rows) {
                const values = Object.values(row).map(formatSqlValue)
                enqueue(
                    `INSERT INTO ${quotedTable} VALUES (${values.join(', ')});\n`
                )
            }

            if (rows.length < batchSize) {
                break
            }

            await pauseForQueuedWork()
        }

        enqueue('\n')
    }
}

export async function dumpDatabaseRoute(
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<Response> {
    try {
        const tablesResult = await executeOperation(
            [
                {
                    sql: "SELECT name FROM sqlite_master WHERE type='table';",
                },
            ],
            dataSource,
            config
        )
        const tables = tablesResult.map((row: any) => String(row.name))

        const encoder = new TextEncoder()
        const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
                try {
                    await enqueueDatabaseDump(
                        controller,
                        encoder,
                        tables,
                        dataSource,
                        config
                    )
                    controller.close()
                } catch (error) {
                    console.error('Database Dump Stream Error:', error)
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
