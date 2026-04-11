import { DataSource } from '../types'
import { executeTransaction } from '../operation'
import { StarbaseDBConfiguration } from '../handler'

/**
 * The number of rows to fetch per chunk when streaming table data.
 * This keeps memory usage bounded regardless of table size.
 */
export const CHUNK_SIZE = 5000

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
 * Check if a table exists in the database.
 */
export async function tableExists(
    tableName: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<boolean> {
    const result = await executeOperation(
        [
            {
                sql: `SELECT name FROM sqlite_master WHERE type='table' AND name=?;`,
                params: [tableName],
            },
        ],
        dataSource,
        config
    )
    return result && result.length > 0
}

/**
 * Fetch a chunk of rows from a table using LIMIT/OFFSET pagination.
 * Returns an empty array when no more rows are available.
 */
export async function getTableDataChunked(
    tableName: string,
    offset: number,
    limit: number,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<any[]> {
    return executeOperation(
        [
            {
                sql: `SELECT * FROM "${tableName}" LIMIT ${limit} OFFSET ${offset};`,
            },
        ],
        dataSource,
        config
    )
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
 * Create a streaming response from a ReadableStream.
 */
export function createStreamingExportResponse(
    stream: ReadableStream,
    fileName: string,
    contentType: string
): Response {
    const headers = new Headers({
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'Transfer-Encoding': 'chunked',
    })

    return new Response(stream, { headers })
}
