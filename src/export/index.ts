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

export async function tableExists(
    tableName: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<boolean> {
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

    return !!(tableExistsResult && tableExistsResult.length)
}

export function quoteIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`
}

export async function forEachPage(
    tableName: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration,
    pageSize: number,
    callback: (rows: any[]) => Promise<void> | void
): Promise<void> {
    const safePageSize =
        Number.isFinite(pageSize) && pageSize > 0 ? pageSize : 1000
    const quotedTableName = quoteIdentifier(tableName)
    let offset = 0

    while (true) {
        const rows = await executeOperation(
            [
                {
                    sql: `SELECT * FROM ${quotedTableName} LIMIT ? OFFSET ?;`,
                    params: [safePageSize, offset],
                },
            ],
            dataSource,
            config
        )

        if (!rows.length) {
            return
        }

        await callback(rows)

        if (rows.length < safePageSize) {
            return
        }

        offset += safePageSize
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

export function createStreamingExportResponse(
    stream: ReadableStream,
    fileName: string,
    contentType: string
): Response {
    const headers = new Headers({
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${fileName}"`,
    })

    return new Response(stream, { headers })
}
