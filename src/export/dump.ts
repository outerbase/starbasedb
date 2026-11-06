import { executeOperation } from '.'
import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { createResponse } from '../utils'

const ROW_BATCH_SIZE = 1000

async function* fetchRowsBatches(
    tableName: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): AsyncGenerator<Record<string, any>[]> {
    let offset = 0
    while (true) {
        const batch = await executeOperation(
            [{ sql: `SELECT * FROM ${tableName} LIMIT ${ROW_BATCH_SIZE} OFFSET ${offset};` }],
            dataSource,
            config
        )
        if (!Array.isArray(batch) || batch.length === 0) break
        yield batch
        if (batch.length < ROW_BATCH_SIZE) break
        offset += ROW_BATCH_SIZE
    }
}

function formatSqlValue(value: any): string {
    if (value === null || value === undefined) return 'NULL'
    if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`
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

        const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
                try {
                    controller.enqueue(encoder.encode('SQLite format 3\0'))

                    for (const table of tables) {
                        const schemaResult = await executeOperation(
                            [
                                {
                                    sql: `SELECT sql FROM sqlite_master WHERE type='table' AND name='${table}';`,
                                },
                            ],
                            dataSource,
                            config
                        )

                        if (schemaResult.length && schemaResult[0].sql) {
                            const schema = schemaResult[0].sql
                            controller.enqueue(
                                encoder.encode(`\n-- Table: ${table}\n${schema};\n\n`)
                            )
                        }

                        for await (const batch of fetchRowsBatches(table, dataSource, config)) {
                            let batchSql = ''
                            for (const row of batch) {
                                const values = Object.values(row).map(formatSqlValue)
                                batchSql += `INSERT INTO ${table} VALUES (${values.join(', ')});\n`
                            }
                            if (batchSql) {
                                controller.enqueue(encoder.encode(batchSql))
                            }
                        }

                        controller.enqueue(encoder.encode('\n'))
                    }

                    controller.close()
                } catch (streamError) {
                    controller.error(streamError)
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
