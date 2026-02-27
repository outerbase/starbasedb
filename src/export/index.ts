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
 * The default page size used for paginated streaming queries.
 * Balances memory usage against the number of round-trips to the database.
 */
const DEFAULT_PAGE_SIZE = 1000

/**
 * Check whether a table exists in the database.
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
    return !!(result && result.length > 0)
}

/**
 * Create a streaming export Response with appropriate headers.
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

/**
 * Fetch rows from a table in pages using LIMIT/OFFSET and invoke a callback
 * for each page. This avoids loading the entire table into memory at once.
 */
export async function forEachPage(
    tableName: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration,
    callback: (rows: any[], isFirstPage: boolean) => Promise<void>,
    pageSize: number = DEFAULT_PAGE_SIZE
): Promise<void> {
    let offset = 0
    let isFirstPage = true

    while (true) {
        const rows = await executeOperation(
            [
                {
                    sql: `SELECT * FROM ${tableName} LIMIT ? OFFSET ?;`,
                    params: [pageSize, offset],
                },
            ],
            dataSource,
            config
        )

        if (!rows || rows.length === 0) break

        await callback(rows, isFirstPage)

        isFirstPage = false
        offset += rows.length

        // If we got fewer rows than the page size we've reached the end.
        if (rows.length < pageSize) break
    }
}
