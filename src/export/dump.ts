import { executeOperation, EXPORT_BATCH_SIZE, quoteIdentifier } from '.'
import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { createResponse } from '../utils'

export interface DumpDatabaseOptions {
    batchSize?: number
    breathingIntervalMs?: number
    workSliceMs?: number
    r2Bucket?: R2Bucket
    r2Key?: string
    callbackUrl?: string
}

export function formatDumpTimestamp(date: Date = new Date()): string {
    const year = date.getUTCFullYear()
    const month = String(date.getUTCMonth() + 1).padStart(2, '0')
    const day = String(date.getUTCDate()).padStart(2, '0')
    const hours = String(date.getUTCHours()).padStart(2, '0')
    const minutes = String(date.getUTCMinutes()).padStart(2, '0')
    const seconds = String(date.getUTCSeconds()).padStart(2, '0')
    return `${year}${month}${day}-${hours}${minutes}${seconds}`
}

export function formatSqlValue(value: unknown): string {
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
    if (value instanceof ArrayBuffer) {
        const hex = Array.from(new Uint8Array(value))
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('')
        return `X'${hex}'`
    }
    if (typeof value === 'object') {
        return `'${JSON.stringify(value).replace(/'/g, "''")}'`
    }
    return String(value)
}

export async function dumpDatabaseRoute(
    dataSource: DataSource,
    config: StarbaseDBConfiguration,
    options: DumpDatabaseOptions = {}
): Promise<Response> {
    try {
        const batchSize = options.batchSize ?? EXPORT_BATCH_SIZE
        const breathingIntervalMs = options.breathingIntervalMs ?? 0
        const workSliceMs = options.workSliceMs ?? 5000

        // Get all table names
        const tablesResult = await executeOperation(
            [{ sql: "SELECT name FROM sqlite_master WHERE type='table';" }],
            dataSource,
            config
        )

        const tables = (tablesResult || []).map((row: any) => row.name)
        const encoder = new TextEncoder()
        const r2Chunks: string[] = []
        const r2Key = options.r2Key ?? `dump_${formatDumpTimestamp()}.sql`

        const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
                try {
                    const emit = (text: string) => {
                        if (options.r2Bucket) {
                            r2Chunks.push(text)
                        }
                        controller.enqueue(encoder.encode(text))
                    }

                    emit('SQLite format 3\0')

                    let sliceStart = Date.now()

                    for (const table of tables) {
                        const escapedTable = String(table).replace(/'/g, "''")
                        const quotedTable = quoteIdentifier(String(table))

                        // Get table schema
                        const schemaResult = await executeOperation(
                            [
                                {
                                    sql: `SELECT sql FROM sqlite_master WHERE type='table' AND name='${escapedTable}';`,
                                },
                            ],
                            dataSource,
                            config
                        )

                        if (schemaResult?.length && schemaResult[0]?.sql) {
                            const schema = schemaResult[0].sql
                            emit(`\n-- Table: ${table}\n${schema};\n\n`)
                        }

                        // Stream table data in paginated batches
                        let offset = 0
                        while (true) {
                            const dataResult =
                                (await executeOperation(
                                    [
                                        {
                                            sql: `SELECT * FROM ${quotedTable} LIMIT ${batchSize} OFFSET ${offset};`,
                                        },
                                    ],
                                    dataSource,
                                    config
                                )) || []

                            if (dataResult.length > 0) {
                                let batchContent = ''
                                for (const row of dataResult) {
                                    const values =
                                        Object.values(row).map(formatSqlValue)
                                    batchContent += `INSERT INTO ${quotedTable} VALUES (${values.join(', ')});\n`
                                }
                                emit(batchContent)
                            }

                            if (dataResult.length < batchSize) {
                                break
                            }

                            offset += batchSize

                            if (
                                breathingIntervalMs > 0 &&
                                Date.now() - sliceStart >= workSliceMs
                            ) {
                                await new Promise((resolve) =>
                                    setTimeout(resolve, breathingIntervalMs)
                                )
                                sliceStart = Date.now()
                            }
                        }

                        emit('\n')
                    }

                    if (options.r2Bucket) {
                        await options.r2Bucket.put(r2Key, r2Chunks.join(''), {
                            httpMetadata: {
                                contentType: 'application/x-sqlite3',
                            },
                        })
                    }

                    if (options.callbackUrl) {
                        await fetch(options.callbackUrl, {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify({
                                status: 'completed',
                                fileName: r2Key,
                                timestamp: new Date().toISOString(),
                            }),
                        })
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
