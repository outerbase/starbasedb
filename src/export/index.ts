import { DataSource } from '../types'
import { executeTransaction } from '../operation'
import { StarbaseDBConfiguration } from '../handler'

export const EXPORT_BATCH_SIZE = 1000

export function quoteSqlIdentifier(identifier: string): string {
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
        const tableIdentifier = quoteSqlIdentifier(tableName)
        const dataResult = await executeOperation(
            [{ sql: `SELECT * FROM ${tableIdentifier};` }],
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

    return !!tableExistsResult && tableExistsResult.length > 0
}

export async function* getTableDataBatches(
    tableName: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration,
    batchSize = EXPORT_BATCH_SIZE
): AsyncGenerator<any[]> {
    let offset = 0
    const tableIdentifier = quoteSqlIdentifier(tableName)
    const normalizedBatchSize = Math.max(1, Math.floor(batchSize))

    while (true) {
        const rows = await executeOperation(
            [
                {
                    sql: `SELECT * FROM ${tableIdentifier} LIMIT ? OFFSET ?;`,
                    params: [normalizedBatchSize, offset],
                },
            ],
            dataSource,
            config
        )

        if (rows.length === 0) {
            break
        }

        yield rows
        offset += rows.length
    }
}

export function createTextStream(
    write: (enqueue: (chunk: string) => void) => Promise<void>
): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder()

    return new ReadableStream<Uint8Array>({
        async start(controller) {
            try {
                await write((chunk) =>
                    controller.enqueue(encoder.encode(chunk))
                )
                controller.close()
            } catch (error) {
                controller.error(error)
            }
        },
    })
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

export function createExportStreamResponse(
    stream: ReadableStream<Uint8Array>,
    fileName: string,
    contentType: string
): Response {
    const headers = new Headers({
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${fileName}"`,
    })

    return new Response(stream, { headers })
}
