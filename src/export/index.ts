import { DataSource } from '../types'
import { executeTransaction } from '../operation'
import { StarbaseDBConfiguration } from '../handler'

export const EXPORT_BATCH_SIZE = 1000

export function quoteIdentifier(name: string): string {
    if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
        return name
    }
    return `"${name.replace(/"/g, '""')}"`
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
    return results.length > 0 && Array.isArray(results[0])
        ? results[0]
        : results
}

export async function getTableData(
    tableName: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration,
    batchSize: number = EXPORT_BATCH_SIZE
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

        const quotedTable = quoteIdentifier(tableName)
        const allRows: any[] = []
        let offset = 0

        while (true) {
            const batch =
                (await executeOperation(
                    [
                        {
                            sql: `SELECT * FROM ${quotedTable} LIMIT ${batchSize} OFFSET ${offset};`,
                        },
                    ],
                    dataSource,
                    config
                )) || []

            allRows.push(...batch)

            if (batch.length < batchSize) {
                break
            }

            offset += batchSize
        }

        return allRows
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
    const headers = new Headers({
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${fileName}"`,
    })

    if (data instanceof ReadableStream) {
        return new Response(data, { headers })
    }

    const blob = new Blob([data], { type: contentType })

    return new Response(blob, { headers })
}
