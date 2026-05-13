import { DataSource } from '../types'
import { executeTransaction } from '../operation'
import { StarbaseDBConfiguration } from '../handler'

export const EXPORT_PAGE_SIZE = 500

export function quoteIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`
}

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

    return tableExistsResult.length > 0
}

export async function getTableDataPage(
    tableName: string,
    offset: number,
    dataSource: DataSource,
    config: StarbaseDBConfiguration,
    limit = EXPORT_PAGE_SIZE
): Promise<any[]> {
    return executeOperation(
        [
            {
                sql: `SELECT * FROM ${quoteIdentifier(tableName)} LIMIT ${limit} OFFSET ${offset};`,
            },
        ],
        dataSource,
        config
    )
}

export async function getTableData(
    tableName: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<any[] | null> {
    try {
        // Verify if the table exists
        if (!(await tableExists(tableName, dataSource, config))) {
            return null
        }

        // Get table data
        return executeOperation(
            [{ sql: `SELECT * FROM ${quoteIdentifier(tableName)};` }],
            dataSource,
            config
        )
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
