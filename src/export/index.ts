import type { DataSource } from '../types'
import { executeTransaction } from '../operation'
import type { StarbaseDBConfiguration } from '../handler'

export const DEFAULT_EXPORT_BATCH_SIZE = 500
export const MAX_EXPORT_BATCH_SIZE = 5000

export type ExportOptions = {
    batchSize?: number | string
}

export type ExportRow = Record<string, unknown>

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
            [{ sql: `SELECT * FROM ${quoteSqlIdentifier(tableName)};` }],
            dataSource,
            config
        )
        return dataResult
    } catch (error: any) {
        console.error('Table Data Fetch Error:', error)
        throw error
    }
}

export function resolveExportBatchSize(
    batchSize?: ExportOptions['batchSize']
): number {
    const parsed =
        typeof batchSize === 'string'
            ? Number.parseInt(batchSize, 10)
            : batchSize

    if (!parsed || Number.isNaN(parsed) || parsed < 1) {
        return DEFAULT_EXPORT_BATCH_SIZE
    }

    return Math.min(Math.floor(parsed), MAX_EXPORT_BATCH_SIZE)
}

export function quoteSqlIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`
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

    return !!tableExistsResult?.length
}

export async function getExportableTables(
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<string[]> {
    const tablesResult = await executeOperation(
        [
            {
                sql: "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';",
            },
        ],
        dataSource,
        config
    )

    return tablesResult
        .map((row: ExportRow) => row.name)
        .filter((name): name is string => typeof name === 'string')
}

export async function getTableColumns(
    tableName: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<string[]> {
    const columnResult = await executeOperation(
        [
            {
                sql: `PRAGMA table_info(${quoteSqlIdentifier(tableName)});`,
            },
        ],
        dataSource,
        config
    )

    return columnResult
        .map((row: ExportRow) => row.name)
        .filter((name): name is string => typeof name === 'string')
}

export async function getTableDataPage(
    tableName: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration,
    limit: number,
    offset: number
): Promise<ExportRow[]> {
    return executeOperation(
        [
            {
                sql: `SELECT * FROM ${quoteSqlIdentifier(tableName)} LIMIT ? OFFSET ?;`,
                params: [limit, offset],
            },
        ],
        dataSource,
        config
    )
}

export async function* iterateTableRows(opts: {
    tableName: string
    dataSource: DataSource
    config: StarbaseDBConfiguration
    batchSize: number
    firstPage?: ExportRow[]
}): AsyncGenerator<ExportRow> {
    const { tableName, dataSource, config, batchSize } = opts
    let offset = 0
    let page = opts.firstPage

    while (true) {
        if (!page) {
            page = await getTableDataPage(
                tableName,
                dataSource,
                config,
                batchSize,
                offset
            )
        }

        if (!page.length) {
            return
        }

        for (const row of page) {
            yield row
        }

        offset += page.length

        if (page.length < batchSize) {
            return
        }

        page = undefined
    }
}

export function createTextStream(
    iterator: AsyncGenerator<string>
): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder()

    return new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                const { value, done } = await iterator.next()

                if (done) {
                    controller.close()
                    return
                }

                controller.enqueue(encoder.encode(value))
            } catch (error) {
                controller.error(error)
            }
        },
        async cancel() {
            await iterator.return?.(undefined)
        },
    })
}

function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
        ''
    )
}

export function formatSqlValue(value: unknown): string {
    if (value === null || value === undefined) {
        return 'NULL'
    }

    if (typeof value === 'number') {
        return Number.isFinite(value) ? String(value) : 'NULL'
    }

    if (typeof value === 'bigint') {
        return value.toString()
    }

    if (typeof value === 'boolean') {
        return value ? '1' : '0'
    }

    if (value instanceof ArrayBuffer) {
        return `X'${bytesToHex(new Uint8Array(value))}'`
    }

    if (ArrayBuffer.isView(value)) {
        const bytes = new Uint8Array(
            value.buffer,
            value.byteOffset,
            value.byteLength
        )
        return `X'${bytesToHex(bytes)}'`
    }

    return `'${String(value).replace(/'/g, "''")}'`
}

export function formatCsvValue(value: unknown): string {
    if (value === null || value === undefined) {
        return ''
    }

    const output = value instanceof Date ? value.toISOString() : String(value)

    if (
        output.includes(',') ||
        output.includes('"') ||
        output.includes('\n') ||
        output.includes('\r')
    ) {
        return `"${output.replace(/"/g, '""')}"`
    }

    return output
}

export function createExportResponse(
    data: BodyInit | null,
    fileName: string,
    contentType: string
): Response {
    const headers = new Headers({
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="${fileName}"`,
    })

    return new Response(data, { headers })
}
