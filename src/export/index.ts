import { DataSource } from '../types'
import { executeTransaction } from '../operation'
import { StarbaseDBConfiguration } from '../handler'

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
 * Fetch table data in chunks to avoid loading everything into memory.
 * Returns an async generator that yields batches of rows.
 */
export async function* getTableDataChunked(
    tableName: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration,
    chunkSize: number = 1000
): AsyncGenerator<any[], void, unknown> {
    let offset = 0

    while (true) {
        const chunk = await executeOperation(
            [
                {
                    sql: `SELECT * FROM ${tableName} LIMIT ? OFFSET ?;`,
                    params: [chunkSize, offset],
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
 * Create a streaming response using TransformStream.
 * The producer function writes to the writable side; the response reads from the readable side.
 */
export function createStreamingExportResponse(
    producer: (writer: WritableStreamDefaultWriter) => Promise<void>,
    fileName: string,
    contentType: string
): Response {
    const { readable, writable } = new TransformStream()

    // Run producer in background — does not block response return
    const writer = writable.getWriter()
    producer(writer).finally(() => {
        writer.close().catch(() => {})
    })

    const headers = new Headers({
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${fileName}"`,
    })

    return new Response(readable, { headers })
}

/**
 * Encode a string chunk and write it to the stream writer.
 */
export async function writeChunk(
    writer: WritableStreamDefaultWriter,
    content: string
): Promise<void> {
    const encoded = new TextEncoder().encode(content)
    await writer.write(encoded)
}
