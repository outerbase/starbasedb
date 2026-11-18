import { executeOperation } from '.'
import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { createResponse } from '../utils'

const DEFAULT_BATCH_SIZE = 500

export interface DumpDatabaseOptions {
    batchSize?: number
}

function formatIdentifier(identifier: string): string {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
        return identifier
    }
    return `"${identifier.replace(/"/g, '""')}"`
}

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
    if (value instanceof Uint8Array) {
        const hex = Array.from(value, (b) =>
            b.toString(16).padStart(2, '0')
        ).join('')
        return `X'${hex}'`
    }
    if (value instanceof ArrayBuffer) {
        const hex = Array.from(new Uint8Array(value), (b) =>
            b.toString(16).padStart(2, '0')
        ).join('')
        return `X'${hex}'`
    }
    return String(value)
}

async function* generateDumpChunks(
    tables: string[],
    dataSource: DataSource,
    config: StarbaseDBConfiguration,
    batchSize: number
): AsyncGenerator<string> {
    yield 'SQLite format 3\0' // SQLite file header

    // Iterate through all tables
    for (const table of tables) {
        // Get table schema
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
            yield `\n-- Table: ${table}\n${schema};\n\n`
        }

        const safeTable = formatIdentifier(table)
        let offset = 0

        // Fetch and stream table data in pages to avoid loading large tables into memory
        while (true) {
            const dataResult = await executeOperation(
                [
                    {
                        sql: `SELECT * FROM ${safeTable} LIMIT ? OFFSET ?;`,
                        params: [batchSize, offset],
                    },
                ],
                dataSource,
                config
            )

            if (!dataResult || dataResult.length === 0) {
                break
            }

            let batchSql = ''
            for (const row of dataResult) {
                const values = Object.values(row).map(formatSqlValue)
                batchSql += `INSERT INTO ${safeTable} VALUES (${values.join(', ')});\n`
            }
            yield batchSql

            if (dataResult.length < batchSize) {
                break
            }

            offset += batchSize
        }

        yield '\n'
    }
}

export async function dumpDatabaseRoute(
    dataSource: DataSource,
    config: StarbaseDBConfiguration,
    options: DumpDatabaseOptions = {}
): Promise<Response> {
    const batchSize =
        options.batchSize && options.batchSize > 0
            ? Math.floor(options.batchSize)
            : DEFAULT_BATCH_SIZE

    try {
        // Get all user table names upfront so initial connection/query failures return HTTP 500
        const tablesResult = await executeOperation(
            [
                {
                    sql: "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';",
                },
            ],
            dataSource,
            config
        )

        const tables: string[] = tablesResult.map((row: any) => row.name)
        const encoder = new TextEncoder()
        const iterator = generateDumpChunks(
            tables,
            dataSource,
            config,
            batchSize
        )

        const stream = new ReadableStream<Uint8Array>({
            async pull(controller) {
                try {
                    const { value, done } = await iterator.next()
                    if (done) {
                        controller.close()
                        return
                    }
                    controller.enqueue(encoder.encode(value))
                } catch (error) {
                    console.error('Database Dump Error:', error)
                    controller.error(error)
                }
            },
            async cancel() {
                await iterator.return?.(undefined)
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
