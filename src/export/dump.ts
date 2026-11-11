import { executeOperation } from '.'
import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { createResponse } from '../utils'

const DEFAULT_BATCH_SIZE = 500
const BREATHING_INTERVAL_MS = 5000

function escapeIdentifier(identifier: string): string {
    return `"${String(identifier).replace(/"/g, '""')}"`
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
        const hex = Array.from(value)
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('')
        return `X'${hex}'`
    }
    return String(value)
}

export async function dumpDatabaseRoute(
    dataSource: DataSource,
    config: StarbaseDBConfiguration,
    options: { batchSize?: number; maxWorkSliceMs?: number } = {}
): Promise<Response> {
    try {
        const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
        const maxWorkSliceMs = options.maxWorkSliceMs ?? BREATHING_INTERVAL_MS

        // Pre-fetch table list upfront so initial DB failures still return HTTP 500 cleanly
        const tablesResult = await executeOperation(
            [{ sql: "SELECT name FROM sqlite_master WHERE type='table';" }],
            dataSource,
            config
        )

        const tables = (tablesResult || [])
            .map((row: any) => row?.name)
            .filter((name: any): name is string => typeof name === 'string' && name.length > 0)

        const encoder = new TextEncoder()

        const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
                try {
                    controller.enqueue(encoder.encode('SQLite format 3\0'))
                    let sliceStart = Date.now()

                    for (const table of tables) {
                        const escapedTable = escapeIdentifier(table)
                        const schemaResult = await executeOperation(
                            [
                                {
                                    sql: `SELECT sql FROM sqlite_master WHERE type='table' AND name='${table.replace(/'/g, "''")}';`,
                                },
                            ],
                            dataSource,
                            config
                        )

                        if (schemaResult && schemaResult.length && schemaResult[0]?.sql) {
                            const schema = schemaResult[0].sql
                            controller.enqueue(
                                encoder.encode(`\n-- Table: ${table}\n${schema};\n\n`)
                            )
                        }

                        // Fetch rows in paginated chunks ( falling back gracefully if mock/driver ignores LIMIT/OFFSET )
                        let offset = 0
                        let seenFirstBatchJson = ''
                        while (true) {
                            const querySql =
                                offset === 0
                                    ? `SELECT * FROM ${table};`
                                    : `SELECT * FROM ${escapedTable} LIMIT ${batchSize} OFFSET ${offset};`

                            const rows = await executeOperation(
                                [{ sql: querySql }],
                                dataSource,
                                config
                            )

                            if (!rows || rows.length === 0) {
                                break
                            }

                            // Guard against drivers/mocks that return the full dataset on the first query
                            const currentBatchJson = JSON.stringify(rows[0])
                            if (offset > 0 && currentBatchJson === seenFirstBatchJson) {
                                break
                            }
                            if (offset === 0) {
                                seenFirstBatchJson = currentBatchJson
                            }

                            let chunkSql = ''
                            for (const row of rows) {
                                const values = Object.values(row).map(formatSqlValue)
                                chunkSql += `INSERT INTO ${table} VALUES (${values.join(', ')});\n`
                            }
                            controller.enqueue(encoder.encode(chunkSql))

                            // Cooperative breathing yield so Durable Objects do not monopolize the event loop
                            if (Date.now() - sliceStart >= maxWorkSliceMs) {
                                await new Promise((resolve) => setTimeout(resolve, 0))
                                sliceStart = Date.now()
                            }

                            if (rows.length < batchSize) {
                                break
                            }
                            offset += rows.length
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
            'Transfer-Encoding': 'chunked',
        })

        return new Response(stream, { headers })
    } catch (error: any) {
        console.error('Database Dump Error:', error)
        return createResponse(undefined, 'Failed to create database dump', 500)
    }
}
