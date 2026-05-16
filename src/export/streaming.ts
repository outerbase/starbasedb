import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { executeOperation } from './index'

export const DEFAULT_EXPORT_PAGE_SIZE = 500

type SchedulerWithWait = {
    wait?: (duration: number) => Promise<void>
}

export type TablePagePlan = {
    columns: string[]
    orderBy: string
    pageSize: number
}

export function quoteSqlIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`
}

function bytesToHex(value: Uint8Array): string {
    return Array.from(value)
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')
}

function binaryToHexLiteral(value: ArrayBuffer | ArrayBufferView): string {
    const bytes =
        value instanceof ArrayBuffer
            ? new Uint8Array(value)
            : new Uint8Array(value.buffer, value.byteOffset, value.byteLength)

    return `X'${bytesToHex(bytes)}'`
}

export function formatSqlValue(value: unknown): string {
    if (value === null || value === undefined) return 'NULL'

    if (typeof value === 'number') {
        return Number.isFinite(value) ? String(value) : 'NULL'
    }

    if (typeof value === 'bigint') return value.toString()
    if (typeof value === 'boolean') return value ? '1' : '0'

    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
        return binaryToHexLiteral(value)
    }

    return `'${String(value).replace(/'/g, "''")}'`
}

export function formatCsvValue(value: unknown): string {
    if (value === null || value === undefined) return ''

    const text =
        value instanceof ArrayBuffer || ArrayBuffer.isView(value)
            ? binaryToHexLiteral(value)
            : String(value)

    if (/[",\r\n]/.test(text)) {
        return `"${text.replace(/"/g, '""')}"`
    }

    return text
}

export function sanitizeExportFileName(fileName: string): string {
    return fileName.replace(/[\x00-\x1f\x7f"\\/:*?<>|]+/g, '_')
}

export async function yieldToRuntime(): Promise<void> {
    const scheduler = (globalThis as { scheduler?: SchedulerWithWait })
        .scheduler

    if (scheduler?.wait) {
        await scheduler.wait(0)
        return
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

export async function tableExists(
    tableName: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<boolean> {
    const result = await executeOperation(
        [
            {
                sql: "SELECT name FROM sqlite_master WHERE type='table' AND name=?;",
                params: [tableName],
            },
        ],
        dataSource,
        config
    )

    return result.length > 0
}

export async function listExportableTables(
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<string[]> {
    const result = await executeOperation(
        [
            {
                sql: "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;",
            },
        ],
        dataSource,
        config
    )

    return result
        .map((row: any) => row.name)
        .filter((name: unknown): name is string => typeof name === 'string')
}

export async function getTableColumns(
    tableName: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<string[]> {
    const result = await executeOperation(
        [{ sql: `PRAGMA table_info(${quoteSqlIdentifier(tableName)});` }],
        dataSource,
        config
    )

    return result
        .map((column: any) => column.name)
        .filter((name: unknown): name is string => typeof name === 'string')
}

export async function getTablePagePlan(
    tableName: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration,
    pageSize = DEFAULT_EXPORT_PAGE_SIZE
): Promise<TablePagePlan> {
    const result = await executeOperation(
        [{ sql: `PRAGMA table_info(${quoteSqlIdentifier(tableName)});` }],
        dataSource,
        config
    )

    const columns = result
        .map((column: any) => column.name)
        .filter((name: unknown): name is string => typeof name === 'string')

    const primaryKeyColumns = result
        .filter((column: any) => Number(column.pk) > 0)
        .sort((left: any, right: any) => Number(left.pk) - Number(right.pk))
        .map((column: any) => quoteSqlIdentifier(column.name))

    return {
        columns,
        orderBy: primaryKeyColumns.length
            ? primaryKeyColumns.join(', ')
            : 'rowid',
        pageSize,
    }
}

export async function* iterateTableRows(
    tableName: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration,
    plan?: TablePagePlan
): AsyncGenerator<Record<string, unknown>> {
    const pagePlan =
        plan ??
        (await getTablePagePlan(
            tableName,
            dataSource,
            config,
            DEFAULT_EXPORT_PAGE_SIZE
        ))
    const quotedTableName = quoteSqlIdentifier(tableName)
    let offset = 0

    while (true) {
        const rows = await executeOperation(
            [
                {
                    sql: `SELECT * FROM ${quotedTableName} ORDER BY ${pagePlan.orderBy} LIMIT ? OFFSET ?;`,
                    params: [pagePlan.pageSize, offset],
                },
            ],
            dataSource,
            config
        )

        if (!rows.length) return

        for (const row of rows) {
            yield row
        }

        offset += rows.length

        if (rows.length < pagePlan.pageSize) return

        await yieldToRuntime()
    }
}

export function createStreamingExportResponse(
    chunks: AsyncIterable<string>,
    fileName: string,
    contentType: string
): Response {
    const encoder = new TextEncoder()
    const iterator = chunks[Symbol.asyncIterator]()

    const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
            try {
                const { done, value } = await iterator.next()

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
            await iterator.return?.()
        },
    })

    return new Response(body, {
        headers: {
            'Cache-Control': 'no-store',
            'Content-Type': contentType,
            'Content-Disposition': `attachment; filename="${sanitizeExportFileName(fileName)}"`,
        },
    })
}
