import { executeOperation } from '.'
import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { createResponse } from '../utils'

export interface DumpStreamingOptions {
    batchSize?: number
    breathingIntervalMs?: number
    yieldEveryBatches?: number
    r2Bucket?: {
        put: (key: string, value: ReadableStream | string | Uint8Array) => Promise<any>
    }
    r2Key?: string
}

function escapeSqlValue(value: any): string {
    if (value === null || value === undefined) {
        return 'NULL'
    }
    if (typeof value === 'boolean') {
        return value ? '1' : '0'
    }
    if (typeof value === 'number') {
        return Number.isFinite(value) ? String(value) : 'NULL'
    }
    if (typeof value === 'string') {
        return `'${value.replace(/'/g, "''")}'`
    }
    return `'${JSON.stringify(value).replace(/'/g, "''")}'`
}

async function cooperativeBreathingPause(ms: number): Promise<void> {
    if (ms > 0) {
        await new Promise((resolve) => setTimeout(resolve, ms))
    } else {
        await Promise.resolve()
    }
}

export function createStreamingDatabaseDump(
    dataSource: DataSource,
    config: StarbaseDBConfiguration,
    options: DumpStreamingOptions = {}
): ReadableStream<Uint8Array> {
    const batchSize = Math.max(1, options.batchSize ?? 500)
    const breathingIntervalMs = Math.max(0, options.breathingIntervalMs ?? 0)
    const yieldEveryBatches = Math.max(1, options.yieldEveryBatches ?? 5)
    const encoder = new TextEncoder()

    return new ReadableStream<Uint8Array>({
        async start(controller) {
            try {
                controller.enqueue(encoder.encode('-- StarbaseDB Streaming SQL Dump\nBEGIN TRANSACTION;\n'))

                const tablesResult = await executeOperation(
                    [
                        {
                            sql: "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%';",
                        },
                    ],
                    dataSource,
                    config
                )

                const tables = (tablesResult || []).map((row: any) => row.name).filter(Boolean)
                let batchesProcessed = 0

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

                    if (schemaResult && schemaResult.length > 0 && schemaResult[0].sql) {
                        controller.enqueue(
                            encoder.encode(`\n-- Table: ${table}\n${schemaResult[0].sql};\n\n`)
                        )
                    }

                    let offset = 0
                    while (true) {
                        const rows = await executeOperation(
                            [
                                {
                                    sql: `SELECT * FROM "${table.replace(/"/g, '""')}" LIMIT ${batchSize} OFFSET ${offset};`,
                                },
                            ],
                            dataSource,
                            config
                        )

                        if (!rows || rows.length === 0) {
                            break
                        }

                        let chunkSql = ''
                        for (const row of rows) {
                            const values = Object.values(row).map(escapeSqlValue)
                            chunkSql += `INSERT INTO "${table.replace(/"/g, '""')}" VALUES (${values.join(', ')});\n`
                        }
                        controller.enqueue(encoder.encode(chunkSql))

                        offset += rows.length
                        batchesProcessed += 1

                        if (batchesProcessed % yieldEveryBatches === 0) {
                            await cooperativeBreathingPause(breathingIntervalMs)
                        }

                        if (rows.length < batchSize) {
                            break
                        }
                    }
                }

                controller.enqueue(encoder.encode('\nCOMMIT;\n'))
                controller.close()
            } catch (err) {
                controller.error(err)
            }
        },
    })
}

export async function dumpDatabaseRoute(
    dataSource: DataSource,
    config: StarbaseDBConfiguration,
    options: DumpStreamingOptions = {}
): Promise<Response> {
    try {
        const stream = createStreamingDatabaseDump(dataSource, config, options)

        if (options.r2Bucket && options.r2Key) {
            await options.r2Bucket.put(options.r2Key, stream)
            return createResponse(
                { key: options.r2Key, status: 'stored_in_r2' },
                'Database dump streamed to object storage',
                200
            )
        }

        const headers = new Headers({
            'Content-Type': 'application/sql; charset=utf-8',
            'Content-Disposition': 'attachment; filename="database_dump.sql"',
            'Transfer-Encoding': 'chunked',
        })

        return new Response(stream, { headers })
    } catch (error: any) {
        console.error('Database Dump Error:', error)
        return createResponse(undefined, 'Failed to create database dump', 500)
    }
}
