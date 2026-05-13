import { executeOperation } from '.'
import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { createResponse } from '../utils'

const DEFAULT_EXPORT_CHUNK_SIZE = 500

function quoteIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`
}

function sqlValue(value: unknown): string {
    if (value === null || value === undefined) return 'NULL'
    if (typeof value === 'number' || typeof value === 'bigint') return String(value)
    if (typeof value === 'boolean') return value ? '1' : '0'
    if (value instanceof ArrayBuffer) {
        return `X'${Array.from(new Uint8Array(value)).map((b) => b.toString(16).padStart(2, '0')).join('')}'`
    }
    return `'${String(value).replace(/'/g, "''")}'`
}

function dumpFilename() {
    return `dump_${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z').replace('T', '-')}.sql`
}

async function notifyCallback(url: string | undefined, payload: Record<string, unknown>) {
    if (!url) return
    try {
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        })
    } catch (error) {
        console.error('Database dump callback failed:', error)
    }
}

export function createDatabaseDumpStream(
    dataSource: DataSource,
    config: StarbaseDBConfiguration,
    chunkSize = DEFAULT_EXPORT_CHUNK_SIZE
): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder()

    return new ReadableStream({
        async start(controller) {
            try {
                controller.enqueue(encoder.encode('SQLite format 3\0'))

                const tablesResult = await executeOperation(
                    [{ sql: "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;" }],
                    dataSource,
                    config
                )
                const tables = tablesResult.map((row: any) => row.name)

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

                    if (schemaResult.length) {
                        controller.enqueue(
                            encoder.encode(`\n-- Table: ${table}\n${schemaResult[0].sql};\n\n`)
                        )
                    }

                    let offset = 0
                    while (true) {
                        const rows = await executeOperation(
                            [
                                {
                                    sql: `SELECT * FROM ${quoteIdentifier(table)} LIMIT ? OFFSET ?;`,
                                    params: [chunkSize, offset],
                                },
                            ],
                            dataSource,
                            config
                        )

                        if (!rows.length) break

                        let chunk = ''
                        for (const row of rows) {
                            const values = Object.values(row).map(sqlValue)
                            chunk += `INSERT INTO ${quoteIdentifier(table)} VALUES (${values.join(', ')});\n`
                        }
                        controller.enqueue(encoder.encode(chunk))

                        if (rows.length < chunkSize) break
                        offset += rows.length
                    }

                    controller.enqueue(encoder.encode('\n'))
                }

                controller.close()
            } catch (error) {
                controller.error(error)
            }
        },
    })
}

async function createAsyncDump(
    request: Request,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
) {
    const bucket = config.export?.bucket
    if (!bucket) {
        return createResponse(
            undefined,
            'Async database dumps require an EXPORT_BUCKET R2 binding.',
            400
        )
    }

    const url = new URL(request.url)
    const filename = url.searchParams.get('filename') || dumpFilename()
    const callbackUrl = url.searchParams.get('callbackUrl') || config.export?.callbackUrl
    const chunkSize = config.export?.chunkSize || DEFAULT_EXPORT_CHUNK_SIZE
    const stream = createDatabaseDumpStream(dataSource, config, chunkSize)
    const job = bucket
        .put(filename, stream, { httpMetadata: { contentType: 'application/x-sqlite3' } })
        .then(() => notifyCallback(callbackUrl, { status: 'completed', filename }))
        .catch((error) => notifyCallback(callbackUrl, { status: 'failed', filename, error: error?.message }))

    dataSource.executionContext?.waitUntil(job)
    if (!dataSource.executionContext) await job

    return createResponse({ filename, status: 'accepted' }, undefined, 202)
}

export async function dumpDatabaseRoute(
    request: Request,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<Response> {
    try {
        if (new URL(request.url).searchParams.get('async') === 'true') {
            return createAsyncDump(request, dataSource, config)
        }

        const headers = new Headers({
            'Content-Type': 'application/x-sqlite3',
            'Content-Disposition': 'attachment; filename="database_dump.sql"',
        })

        return new Response(
            createDatabaseDumpStream(
                dataSource,
                config,
                config.export?.chunkSize || DEFAULT_EXPORT_CHUNK_SIZE
            ),
            { headers }
        )
    } catch (error: any) {
        console.error('Database Dump Error:', error)
        return createResponse(undefined, 'Failed to create database dump', 500)
    }
}
