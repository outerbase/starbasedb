import { executeOperation } from '.'
import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { createResponse } from '../utils'

const DEFAULT_BATCH_SIZE = 500

function escapeIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`
}

function escapeSqlValue(value: unknown): string {
    if (value === null || value === undefined) {
        return 'NULL'
    }

    if (typeof value === 'number' || typeof value === 'bigint') {
        return String(value)
    }

    if (typeof value === 'boolean') {
        return value ? '1' : '0'
    }

    if (value instanceof Uint8Array) {
        const hex = Array.from(value)
            .map((byte) => byte.toString(16).padStart(2, '0'))
            .join('')
        return `X'${hex}'`
    }

    if (typeof value === 'object') {
        return `'${JSON.stringify(value).replace(/'/g, "''")}'`
    }

    return `'${String(value).replace(/'/g, "''")}'`
}

async function* generateDumpChunks(
    dataSource: DataSource,
    config: StarbaseDBConfiguration,
    batchSize: number
): AsyncGenerator<string> {
    const tablesResult = await executeOperation(
        [{ sql: "SELECT name FROM sqlite_master WHERE type='table';" }],
        dataSource,
        config
    )

    const tables = tablesResult
        .map((row: any) => row.name)
        .filter((table: unknown): table is string => typeof table === 'string')

    yield 'SQLite format 3\0'

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

        if (schemaResult.length && schemaResult[0].sql) {
            const schema = schemaResult[0].sql
            yield `\n-- Table: ${table}\n${schema};\n\n`
        }

        const escapedTableName = escapeIdentifier(table)
        let offset = 0

        while (true) {
            const dataResult = await executeOperation(
                [
                    {
                        sql: `SELECT * FROM ${escapedTableName} LIMIT ? OFFSET ?;`,
                        params: [batchSize, offset],
                    },
                ],
                dataSource,
                config
            )

            if (!dataResult.length) {
                break
            }

            for (const row of dataResult) {
                const values = Object.values(row).map(escapeSqlValue)
                yield `INSERT INTO ${escapedTableName} VALUES (${values.join(', ')});\n`
            }

            offset += dataResult.length
        }

        yield '\n'
    }
}

export async function dumpDatabaseRoute(
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<Response> {
    try {
        const chunkIterator = generateDumpChunks(
            dataSource,
            config,
            DEFAULT_BATCH_SIZE
        )

        // Resolve the first chunk before returning so startup failures surface as a 500 response.
        const firstChunk = await chunkIterator.next()

        const encoder = new TextEncoder()
        const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
                try {
                    if (!firstChunk.done) {
                        controller.enqueue(encoder.encode(firstChunk.value))
                    }

                    for await (const chunk of chunkIterator) {
                        controller.enqueue(encoder.encode(chunk))
                    }

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
