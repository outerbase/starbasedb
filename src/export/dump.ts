import { DataSource } from '../types'
import { createResponse } from '../utils'
import { executeOperation } from './index'
import { StarbaseDBConfiguration } from '../handler'

const DEFAULT_EXPORT_CHUNK_SIZE = 1000

// SQLite database file magic string
const SQLITE_HEADER = 'SQLite format 3\0'

// Alias used for rowid keyset pagination
const ROWID_ALIAS = '__starbasedb_export_rowid__'

// Quote a SQL identifier
function quoteIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`
}

// Render values as SQL literals
function toSqlLiteral(value: unknown): string {
    if (value === null || value === undefined) {
        return 'NULL'
    }
    if (typeof value === 'number' || typeof value === 'bigint') {
        return String(value)
    }
    if (typeof value === 'boolean') {
        return value ? '1' : '0'
    }
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
        const bytes =
            value instanceof ArrayBuffer
                ? new Uint8Array(value)
                : new Uint8Array(
                      value.buffer,
                      value.byteOffset,
                      value.byteLength
                  )
        const hex = Array.from(bytes)
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('')
        return `X'${hex}'`
    }
    return `'${String(value).replace(/'/g, "''")}'`
}

function dumpFilename(): string {
    const now = new Date()
    const yyyymmdd = now.toISOString().slice(0, 10).replace(/-/g, '')
    const hhmmss = now.toISOString().slice(11, 19).replace(/:/g, '')
    return `dump_${yyyymmdd}-${hhmmss}.sql`
}

async function notifyCallback(
    url: string | undefined,
    payload: Record<string, unknown>
) {
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

// R2 Multipart Writer to upload chunks to R2 producing a single .sql file
class R2MultipartWriter {
    private bucket: R2Bucket
    private key: string
    private uploadPromise: Promise<any>
    private multipartUpload!: R2MultipartUpload
    private partNumber = 1
    private parts: { partNumber: number; etag: string }[] = []
    private buffer = ''
    private minPartSize = 5 * 1024 * 1024 // 5 MiB

    constructor(bucket: R2Bucket, key: string) {
        this.bucket = bucket
        this.key = key
        this.uploadPromise = this.init()
    }

    private async init() {
        this.multipartUpload = await this.bucket.createMultipartUpload(
            this.key,
            {
                httpMetadata: { contentType: 'application/sql' },
            }
        )
    }

    public async write(chunk: string) {
        await this.uploadPromise
        this.buffer += chunk

        if (this.buffer.length >= this.minPartSize) {
            const partData = this.buffer
            this.buffer = ''
            const partNum = this.partNumber++
            const part = await this.multipartUpload.uploadPart(
                partNum,
                partData
            )
            this.parts.push({ partNumber: partNum, etag: part.etag })
        }
    }

    public async close() {
        await this.uploadPromise
        if (this.buffer.length > 0) {
            const partNum = this.partNumber++
            const part = await this.multipartUpload.uploadPart(
                partNum,
                this.buffer
            )
            this.parts.push({ partNumber: partNum, etag: part.etag })
            this.buffer = ''
        }
        await this.multipartUpload.complete(this.parts)
    }

    public async abort() {
        try {
            await this.uploadPromise
            await this.multipartUpload.abort()
        } catch (e) {
            // ignore
        }
    }
}

// List all user tables
async function listTables(
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<string[]> {
    const rows = await executeOperation(
        [
            {
                sql: "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;",
            },
        ],
        dataSource,
        config
    )
    return rows.map((row: any) => row.name as string)
}

// Yield table rows in pages
async function* streamTableRows(
    table: string,
    keyset: boolean,
    pageSize: number,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): AsyncGenerator<Record<string, any>[]> {
    const quoted = quoteIdentifier(table)

    if (keyset) {
        let cursor: unknown = undefined
        while (true) {
            const sql =
                cursor === undefined
                    ? `SELECT *, _rowid_ AS ${ROWID_ALIAS} FROM ${quoted} ORDER BY _rowid_ LIMIT ?;`
                    : `SELECT *, _rowid_ AS ${ROWID_ALIAS} FROM ${quoted} WHERE _rowid_ > ? ORDER BY _rowid_ LIMIT ?;`
            const params =
                cursor === undefined ? [pageSize] : [cursor, pageSize]

            const rows = await executeOperation(
                [{ sql, params }],
                dataSource,
                config
            )
            if (!rows.length) return

            const nextCursor = rows[rows.length - 1][ROWID_ALIAS]
            for (const row of rows) {
                delete row[ROWID_ALIAS]
            }

            yield rows

            if (rows.length < pageSize || nextCursor === undefined) return
            cursor = nextCursor
        }
    } else {
        let offset = 0
        while (true) {
            const rows = await executeOperation(
                [
                    {
                        sql: `SELECT * FROM ${quoted} LIMIT ? OFFSET ?;`,
                        params: [pageSize, offset],
                    },
                ],
                dataSource,
                config
            )
            if (!rows.length) return

            yield rows

            if (rows.length < pageSize) return
            offset += rows.length
        }
    }
}

// Generate SQL dump chunks
async function* generateDump(
    tables: string[],
    pageSize: number,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): AsyncGenerator<string> {
    yield SQLITE_HEADER

    for (const table of tables) {
        const schemaRows = await executeOperation(
            [
                {
                    sql: "SELECT sql FROM sqlite_master WHERE type='table' AND name=?;",
                    params: [table],
                },
            ],
            dataSource,
            config
        )

        const schema: string | undefined = schemaRows[0]?.sql
        if (!schema) continue

        yield `\n-- Table: ${table}\n${schema};\n\n`

        const quoted = quoteIdentifier(table)
        const keyset = !/without\s+rowid/i.test(schema)

        for await (const rows of streamTableRows(
            table,
            keyset,
            pageSize,
            dataSource,
            config
        )) {
            let chunk = ''
            for (const row of rows) {
                const values = Object.values(row).map(toSqlLiteral)
                chunk += `INSERT INTO ${quoted} VALUES (${values.join(', ')});\n`
            }
            yield chunk
        }

        yield '\n'
    }
}

// Adapt AsyncGenerator to ReadableStream
function toReadableStream(
    chunks: AsyncGenerator<string>,
    onChunkSent?: () => Promise<void>
): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder()
    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                const { done, value } = await chunks.next()
                if (done) {
                    controller.close()
                    return
                }
                if (value) {
                    controller.enqueue(encoder.encode(value))
                    if (onChunkSent) {
                        await onChunkSent()
                    }
                }
            } catch (error) {
                controller.error(error)
            }
        },
        async cancel() {
            await chunks.return(undefined)
        },
    })
}

// Background async R2 backup processor
async function runAsyncDumpInBackground(
    bucket: R2Bucket,
    filename: string,
    callbackUrl: string | undefined,
    chunkSize: number,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<void> {
    const writer = new R2MultipartWriter(bucket, filename)
    try {
        const tables = await listTables(dataSource, config)
        const dump = generateDump(tables, chunkSize, dataSource, config)

        for await (const chunk of dump) {
            await writer.write(chunk)
            // Breathing interval to yield the DO event loop
            await new Promise((resolve) => setTimeout(resolve, 10))
        }

        await writer.close()

        if (callbackUrl) {
            await notifyCallback(callbackUrl, {
                status: 'completed',
                filename,
                timestamp: new Date().toISOString(),
            })
        }
    } catch (error: any) {
        console.error('Async Database Dump Error:', error)
        await writer.abort()
        if (callbackUrl) {
            await notifyCallback(callbackUrl, {
                status: 'failed',
                filename,
                error: error?.message || String(error),
                timestamp: new Date().toISOString(),
            })
        }
    }
}

export async function dumpDatabaseRoute(
    request: Request,
    dataSource: DataSource,
    config: StarbaseDBConfiguration,
    ctx?: ExecutionContext
): Promise<Response> {
    try {
        const url = new URL(request.url)
        const isAsync = url.searchParams.get('async') === 'true'

        if (isAsync) {
            const bucket = config.export?.bucket
            if (!bucket) {
                return createResponse(
                    undefined,
                    'Async database dumps require an EXPORT_BUCKET R2 binding.',
                    400
                )
            }
            const filename = url.searchParams.get('filename') || dumpFilename()
            const callbackUrl =
                url.searchParams.get('callbackUrl') ||
                config.export?.callbackUrl
            const chunkSize = Number(
                config.export?.chunkSize || DEFAULT_EXPORT_CHUNK_SIZE
            )

            const promise = runAsyncDumpInBackground(
                bucket,
                filename,
                callbackUrl,
                chunkSize,
                dataSource,
                config
            )

            if (ctx) {
                ctx.waitUntil(promise)
            } else {
                // Return immediate 202, run promise in background without blocking
                promise.catch((err) =>
                    console.error('Background dump failed:', err)
                )
            }

            return createResponse(
                {
                    filename,
                    status: 'running',
                    message: 'Database dump started in the background.',
                },
                undefined,
                202
            )
        }

        const tables = await listTables(dataSource, config)
        const pageSize = Number(
            config.export?.chunkSize || DEFAULT_EXPORT_CHUNK_SIZE
        )

        const headers = new Headers({
            'Content-Type': 'application/x-sqlite3',
            'Content-Disposition': 'attachment; filename="database_dump.sql"',
        })

        // Stream direct download
        const body = toReadableStream(
            generateDump(tables, pageSize, dataSource, config),
            async () => {
                // Yield event loop
                await new Promise((resolve) => setTimeout(resolve, 0))
            }
        )

        return new Response(body, { headers })
    } catch (error: any) {
        console.error('Database Dump Error:', error)
        return createResponse(undefined, 'Failed to create database dump', 500)
    }
}
