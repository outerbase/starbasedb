import { DataSource } from '../types'
import { executeTransaction } from '../operation'
import { StarbaseDBConfiguration } from '../handler'

export const DEFAULT_EXPORT_BATCH_SIZE = 500
export const DEFAULT_MAX_ACTIVE_WINDOW_MS = 5000

export interface PaginatedTableOptions {
    batchSize?: number
    breathingIntervalMs?: number
    maxActiveWindowMs?: number
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

export async function* paginateTableData(
    tableName: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration,
    options: PaginatedTableOptions = {}
): AsyncGenerator<any[], void, unknown> {
    const batchSize = Math.max(1, options.batchSize ?? DEFAULT_EXPORT_BATCH_SIZE)
    const breathingIntervalMs = Math.max(0, options.breathingIntervalMs ?? 0)
    const maxActiveWindowMs = Math.max(
        1,
        options.maxActiveWindowMs ?? DEFAULT_MAX_ACTIVE_WINDOW_MS
    )

    let offset = 0
    let windowStart = Date.now()

    while (true) {
        const batch = await executeOperation(
            [
                {
                    sql: `SELECT * FROM ${tableName} LIMIT ${batchSize} OFFSET ${offset};`,
                },
            ],
            dataSource,
            config
        )

        if (!Array.isArray(batch) || batch.length === 0) {
            break
        }

        yield batch

        if (batch.length < batchSize) {
            break
        }

        offset += batch.length

        if (
            breathingIntervalMs > 0 &&
            Date.now() - windowStart >= maxActiveWindowMs
        ) {
            await new Promise((resolve) =>
                setTimeout(resolve, breathingIntervalMs)
            )
            windowStart = Date.now()
        }
    }
}

export async function getTableData(
    tableName: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration,
    options: PaginatedTableOptions = {}
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

        const allRows: any[] = []
        for await (const batch of paginateTableData(
            tableName,
            dataSource,
            config,
            options
        )) {
            allRows.push(...batch)
        }
        return allRows
    } catch (error: any) {
        console.error('Table Data Fetch Error:', error)
        throw error
    }
}

export function createExportResponse(
    data: BlobPart | BlobPart[],
    fileName: string,
    contentType: string
): Response {
    const parts = Array.isArray(data) ? data : [data]
    const blob = new Blob(parts, { type: contentType })

    const headers = new Headers({
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${fileName}"`,
    })

    return new Response(blob, { headers })
}
