import { executeOperation } from '.'
import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { createResponse } from '../utils'

// SQLite file header written at the top of every dump.
const SQLITE_HEADER = 'SQLite format 3\0'

// Number of rows fetched per page. Paging keeps the amount of data held in
// memory bounded regardless of how large the underlying table is, so even a
// multi-gigabyte table can be dumped without loading it all at once.
const DUMP_PAGE_SIZE = 1000

// R2 requires every part of a multipart upload (except the final one) to be at
// least 5 MiB. We buffer encoded chunks until they cross this threshold before
// flushing a part, which lets us stream an arbitrarily large dump into a single
// R2 object without ever holding the whole file in memory.
const R2_MIN_PART_SIZE = 5 * 1024 * 1024

/**
 * Format a timestamp into the `YYYYMMDD-HHMMSS` form used for dump filenames,
 * e.g. `2024-01-01 17:00:00` UTC becomes `20240101-170000`.
 */
export function formatDumpTimestamp(date: Date): string {
    const pad = (value: number) => String(value).padStart(2, '0')
    const year = date.getUTCFullYear()
    const month = pad(date.getUTCMonth() + 1)
    const day = pad(date.getUTCDate())
    const hours = pad(date.getUTCHours())
    const minutes = pad(date.getUTCMinutes())
    const seconds = pad(date.getUTCSeconds())
    return `${year}${month}${day}-${hours}${minutes}${seconds}`
}

/**
 * Convert a single column value into its SQL literal representation. Handles the
 * boundary cases the naive implementation skipped: NULL/undefined, booleans and
 * binary BLOB values, in addition to escaping single quotes inside strings.
 */
export function escapeSqlValue(value: unknown): string {
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
        let hex = ''
        for (const byte of bytes) {
            hex += byte.toString(16).padStart(2, '0')
        }
        return `X'${hex}'`
    }

    return `'${String(value).replace(/'/g, "''")}'`
}

/**
 * Stream the database dump as a sequence of string chunks. The full database is
 * never materialised in memory at once: table data is paged with LIMIT/OFFSET so
 * each iteration only holds a single page of rows.
 */
export async function* generateDumpChunks(
    tables: string[],
    dataSource: DataSource,
    config: StarbaseDBConfiguration,
    pageSize: number = DUMP_PAGE_SIZE
): AsyncGenerator<string> {
    yield SQLITE_HEADER

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

        // Page through the table data so a large table never has to be loaded
        // into memory in its entirety.
        let offset = 0
        while (true) {
            const rows = await executeOperation(
                [
                    {
                        sql: `SELECT * FROM "${table}" LIMIT ${pageSize} OFFSET ${offset};`,
                    },
                ],
                dataSource,
                config
            )

            if (!rows.length) {
                break
            }

            let chunk = ''
            for (const row of rows) {
                const values = Object.values(row).map(escapeSqlValue)
                chunk += `INSERT INTO ${table} VALUES (${values.join(', ')});\n`
            }
            yield chunk

            // A short page means we have reached the end of the table.
            if (rows.length < pageSize) {
                break
            }
            offset += pageSize
        }

        yield '\n'
    }
}

/**
 * Fetch the list of user table names from the database.
 */
async function getTableNames(
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<string[]> {
    const tablesResult = await executeOperation(
        [{ sql: "SELECT name FROM sqlite_master WHERE type='table';" }],
        dataSource,
        config
    )

    return tablesResult.map((row: any) => row.name)
}

/**
 * Upload a database dump to R2 using a multipart upload. Encoded chunks are
 * buffered until they exceed R2's minimum part size and then flushed as a part,
 * allowing a dump of any size to be written without buffering the whole file.
 * When a `callbackUrl` is provided it is notified once the upload completes.
 */
export async function uploadDumpToR2(
    bucket: R2Bucket,
    key: string,
    tables: string[],
    dataSource: DataSource,
    config: StarbaseDBConfiguration,
    callbackUrl?: string
): Promise<void> {
    const encoder = new TextEncoder()
    const upload = await bucket.createMultipartUpload(key)
    const parts: R2UploadedPart[] = []
    let pending: Uint8Array[] = []
    let pendingBytes = 0

    const flush = async () => {
        if (pendingBytes === 0) {
            return
        }

        const part = new Uint8Array(pendingBytes)
        let offset = 0
        for (const buffer of pending) {
            part.set(buffer, offset)
            offset += buffer.length
        }

        const uploaded = await upload.uploadPart(parts.length + 1, part)
        parts.push(uploaded)
        pending = []
        pendingBytes = 0
    }

    try {
        for await (const chunk of generateDumpChunks(
            tables,
            dataSource,
            config
        )) {
            const encoded = encoder.encode(chunk)
            pending.push(encoded)
            pendingBytes += encoded.length

            if (pendingBytes >= R2_MIN_PART_SIZE) {
                await flush()
            }
        }

        // Flush whatever remains as the final part (which may be < 5 MiB).
        await flush()
        await upload.complete(parts)
    } catch (error) {
        // Abort the multipart upload so we never leave a partial object behind.
        try {
            await upload.abort()
        } catch (abortError) {
            console.error('Failed to abort R2 multipart upload:', abortError)
        }
        throw error
    }

    if (callbackUrl) {
        try {
            await fetch(callbackUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key, status: 'completed' }),
            })
        } catch (error) {
            console.error('Failed to notify dump callback URL:', error)
        }
    }
}

export async function dumpDatabaseRoute(
    dataSource: DataSource,
    config: StarbaseDBConfiguration,
    request?: Request
): Promise<Response> {
    try {
        const url = request ? new URL(request.url) : undefined
        const wantsR2 =
            url?.searchParams.get('location') === 'r2' ||
            url?.searchParams.get('r2') === 'true'
        const callbackUrl = url?.searchParams.get('callback') ?? undefined

        // Resolve the table list up-front so connection/auth errors surface as a
        // normal error response before we start streaming a body.
        const tables = await getTableNames(dataSource, config)

        // When the caller asks to offload to R2 we stream the dump into an R2
        // object instead of the response body. This removes the 30 second
        // request limit from the equation for very large databases: the upload
        // continues in the background and the optional callback URL notifies the
        // caller once the file is ready.
        if (wantsR2) {
            const bucket = dataSource.dumpBucket
            if (!bucket) {
                return createResponse(
                    undefined,
                    'R2 bucket binding (DATABASE_DUMP_BUCKET) is required to offload a dump.',
                    400
                )
            }

            const key = `dump_${formatDumpTimestamp(new Date())}.sql`
            const work = uploadDumpToR2(
                bucket,
                key,
                tables,
                dataSource,
                config,
                callbackUrl
            )

            const ctx = dataSource.executionContext
            if (ctx?.waitUntil) {
                ctx.waitUntil(work)
                return createResponse(
                    { key, status: 'accepted' },
                    undefined,
                    202
                )
            }

            await work
            return createResponse({ key, status: 'completed' }, undefined, 200)
        }

        // Default behaviour: stream the dump straight back to the caller. The
        // response is produced incrementally so the database is never buffered
        // in memory in its entirety.
        const encoder = new TextEncoder()
        const iterator = generateDumpChunks(tables, dataSource, config)
        const stream = new ReadableStream({
            async pull(controller) {
                try {
                    const { value, done } = await iterator.next()
                    if (done) {
                        controller.close()
                    } else {
                        controller.enqueue(encoder.encode(value))
                    }
                } catch (error) {
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
