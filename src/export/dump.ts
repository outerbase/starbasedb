import { executeOperation } from '.'
import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { createResponse } from '../utils'

const BATCH_SIZE = 5000
const YIELD_INTERVAL = 100

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
}

async function* generateDumpChunks(
    tables: string[],
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): AsyncGenerator<string> {
    yield 'SQLite format 3\0'

    let rowCounter = 0

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

        if (schemaResult.length) {
            const schema = schemaResult[0].sql
            yield `\n-- Table: ${table}\n${schema};\n\n`
        }

        // Get row count for this table
        const countResult = await executeOperation(
            [{ sql: `SELECT COUNT(*) as count FROM ${table};` }],
            dataSource,
            config
        )
        const totalRows = countResult[0]?.count ?? 0

        // Fetch rows in batches using LIMIT/OFFSET to avoid loading all data into memory
        let offset = 0
        while (offset < totalRows) {
            const batchResult = await executeOperation(
                [
                    {
                        sql: `SELECT * FROM ${table} LIMIT ${BATCH_SIZE} OFFSET ${offset};`,
                    },
                ],
                dataSource,
                config
            )

            let batchContent = ''
            for (const row of batchResult) {
                const values = Object.values(row).map((value) =>
                    typeof value === 'string'
                        ? `'${value.replace(/'/g, "''")}'`
                        : value
                )
                batchContent += `INSERT INTO ${table} VALUES (${values.join(', ')});\n`
            }

            yield batchContent
            offset += BATCH_SIZE
            rowCounter += batchResult.length

            // Yield control periodically to prevent blocking the event loop
            // and avoid exceeding CF Workers' CPU time limits
            if (rowCounter >= YIELD_INTERVAL) {
                rowCounter = 0
                await sleep(0)
            }
        }

        yield '\n'
    }
}

export async function dumpDatabaseRoute(
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<Response> {
    try {
        // Get all table names upfront so errors here are caught immediately
        const tablesResult = await executeOperation(
            [{ sql: "SELECT name FROM sqlite_master WHERE type='table';" }],
            dataSource,
            config
        )

        const tables = tablesResult.map((row: any) => row.name)
        const encoder = new TextEncoder()
        const generator = generateDumpChunks(tables, dataSource, config)

        const stream = new ReadableStream({
            async pull(controller) {
                const { value, done } = await generator.next()
                if (done) {
                    controller.close()
                } else {
                    controller.enqueue(encoder.encode(value))
                }
            },
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
