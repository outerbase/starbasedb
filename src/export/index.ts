import { DataSource } from '../types'
import { executeTransaction } from '../operation'
import { StarbaseDBConfiguration } from '../handler'

const CHUNK_SIZE = 1000

export async function executeOperation(
    queries: { sql: string; params?: any[] }[],
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<any[]> {
    const results: any[] = (await executeTransaction({
        queries,
        isRaw: false,
        dataSource,
        config,
    })) as any[]
    // return results?.length > 0 ? results[0] : undefined
    return results.length > 0 && Array.isArray(results[0])
        ? results[0]
        : results
}

export async function getTableData(
    tableName: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<any[] | null> {
    try {
        // Verify if the table exists
        const tableExistsResult = await executeOperation(
            [
                {
                    sql: `SELECT name FROM sqlite_master WHERE type='table' AND name=?;`,
                    params: [tableName],
                },
            ],
            dataSource,
            config
        )

        if (!tableExistsResult || tableExistsResult.length === 0) {
            return null
        }

        // Get table data
        const dataResult = await executeOperation(
            [{ sql: `SELECT * FROM ${tableName};` }],
            dataSource,
            config
        )
        return dataResult
    } catch (error: any) {
        console.error('Table Data Fetch Error:', error)
        throw error
    }
}

/**
 * Async generator that yields rows from a table in chunks using LIMIT/OFFSET.
 * This avoids loading the entire table into memory and prevents 30-second
 * Durable Objects timeout on large databases.
 */
export async function* getTableDataChunked(
    tableName: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration,
    chunkSize: number = CHUNK_SIZE
): AsyncGenerator<any[]> {
    let offset = 0

    while (true) {
        const chunk = await executeOperation(
            [
                {
                    sql: `SELECT * FROM ${tableName} LIMIT ${chunkSize} OFFSET ${offset};`,
                },
            ],
            dataSource,
            config
        )

        if (!chunk || chunk.length === 0) {
            break
        }

        yield chunk

        if (chunk.length < chunkSize) {
            // Fetched fewer rows than the chunk size — we are done
            break
        }

        offset += chunkSize
    }
}

export function createExportResponse(
    data: any,
    fileName: string,
    contentType: string
): Response {
    const blob = new Blob([data], { type: contentType })

    const headers = new Headers({
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${fileName}"`,
    })

    return new Response(blob, { headers })
}

/**
 * Creates a streaming HTTP response by consuming an async generator of
 * string chunks.  Each yielded string is encoded and enqueued into a
 * TransformStream so the response body is flushed incrementally rather
 * than buffered in memory.
 */
export function createStreamingExportResponse(
    fileName: string,
    contentType: string,
    generator: AsyncGenerator<string>
): Response {
    const { readable, writable } = new TransformStream<string, Uint8Array>({
        transform(chunk, controller) {
            controller.enqueue(new TextEncoder().encode(chunk))
        },
    })

    // Write asynchronously in the background; the readable side streams to
    // the client as data becomes available.
    const writer = writable.getWriter()
    ;(async () => {
        try {
            for await (const chunk of generator) {
                await writer.write(chunk)
            }
        } finally {
            await writer.close()
        }
    })()

    const headers = new Headers({
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'Transfer-Encoding': 'chunked',
    })

    return new Response(readable as any, { headers })
}
