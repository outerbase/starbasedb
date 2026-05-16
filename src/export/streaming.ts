import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { executeOperation } from '.'

export const DEFAULT_EXPORT_PAGE_SIZE = 1000

type SchedulerWithWait = {
    wait?: (duration: number) => Promise<void>
}

type TableInfoRow = {
    name?: unknown
    pk?: unknown
}

export type TableExportPlan = {
    columns: string[]
    orderBy: string
    usesRowIdCursor: boolean
    rowIdExpression?: string
    cursorAlias?: string
}

export function quoteSqlIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`
}

function chooseHiddenRowIdExpression(columns: string[]): string | undefined {
    const columnNames = new Set(columns.map((column) => column.toLowerCase()))
    return ['rowid', '_rowid_', 'oid'].find((name) => !columnNames.has(name))
}

function chooseExportCursorAlias(columns: string[]): string {
    const columnNames = new Set(columns.map((column) => column.toLowerCase()))
    let alias = '__starbasedb_export_cursor_rowid'
    let suffix = 2

    while (columnNames.has(alias.toLowerCase())) {
        alias = `__starbasedb_export_cursor_rowid_${suffix}`
        suffix += 1
    }

    return alias
}

function bytesToHex(value: Uint8Array): string {
    return Array.from(value)
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')
}

function valueToText(value: unknown): string {
    if (value === null || value === undefined) {
        return ''
    }

    if (value instanceof Uint8Array) {
        return bytesToHex(value)
    }

    if (value instanceof ArrayBuffer) {
        return bytesToHex(new Uint8Array(value))
    }

    return String(value)
}

export function formatSqlValue(value: unknown): string {
    if (value === null || value === undefined) {
        return 'NULL'
    }

    if (typeof value === 'number' || typeof value === 'bigint') {
        return String(value)
    }

    if (typeof value === 'boolean') {
        return value ? '1' : '0'
    }

    if (value instanceof Uint8Array) {
        return `X'${bytesToHex(value)}'`
    }

    if (value instanceof ArrayBuffer) {
        return `X'${bytesToHex(new Uint8Array(value))}'`
    }

    return `'${String(value).replace(/'/g, "''")}'`
}

export function formatCsvValue(value: unknown): string {
    const text = valueToText(value)

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

export async function getTableColumns(
    tableName: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<string[]> {
    return (await getTableExportPlan(tableName, dataSource, config)).columns
}

async function getTableInfo(
    tableName: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<TableInfoRow[]> {
    const result = await executeOperation(
        [
            {
                sql: `PRAGMA table_info(${quoteSqlIdentifier(tableName)});`,
            },
        ],
        dataSource,
        config
    )

    return result as TableInfoRow[]
}

async function getTableSql(
    tableName: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<string> {
    const result = await executeOperation(
        [
            {
                sql: `SELECT sql FROM sqlite_master WHERE type='table' AND name=?;`,
                params: [tableName],
            },
        ],
        dataSource,
        config
    )

    const rows = Array.isArray(result) ? result : []

    return typeof rows[0]?.sql === 'string' ? rows[0].sql : ''
}

export async function getTableExportPlan(
    tableName: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration,
    schemaSql?: string
): Promise<TableExportPlan> {
    const tableInfo = await getTableInfo(tableName, dataSource, config)
    const columns = tableInfo
        .map((column) => column.name)
        .filter((name): name is string => typeof name === 'string')
    const resolvedSchemaSql =
        schemaSql ?? (await getTableSql(tableName, dataSource, config))
    const withoutRowId = /\bWITHOUT\s+ROWID\b/i.test(resolvedSchemaSql)
    const rowIdExpression = withoutRowId
        ? undefined
        : chooseHiddenRowIdExpression(columns)

    if (rowIdExpression) {
        return {
            columns,
            orderBy: rowIdExpression,
            usesRowIdCursor: true,
            rowIdExpression,
            cursorAlias: chooseExportCursorAlias(columns),
        }
    }

    const primaryKeyColumns = tableInfo
        .filter((column) => Number(column.pk ?? 0) > 0)
        .sort((left, right) => Number(left.pk ?? 0) - Number(right.pk ?? 0))
        .map((column) => column.name)
        .filter((name): name is string => typeof name === 'string')
    const orderColumns = primaryKeyColumns.length ? primaryKeyColumns : columns

    return {
        columns,
        orderBy: orderColumns.map(quoteSqlIdentifier).join(', '),
        usesRowIdCursor: false,
    }
}

function copyExportColumns(row: Record<string, unknown>, columns: string[]) {
    return Object.fromEntries(columns.map((column) => [column, row[column]]))
}

export async function* iterateTableRows(
    tableName: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration,
    pageSize = DEFAULT_EXPORT_PAGE_SIZE,
    exportPlan?: TableExportPlan
): AsyncGenerator<Record<string, unknown>> {
    const quotedTableName = quoteSqlIdentifier(tableName)
    const tableExportPlan =
        exportPlan ?? (await getTableExportPlan(tableName, dataSource, config))
    const selectedColumns = tableExportPlan.columns.length
        ? tableExportPlan.columns.map(quoteSqlIdentifier).join(', ')
        : '*'

    if (tableExportPlan.usesRowIdCursor) {
        let lastRowId: number | null = null
        const rowIdExpression = tableExportPlan.rowIdExpression ?? 'rowid'
        const cursorAlias =
            tableExportPlan.cursorAlias ?? chooseExportCursorAlias([])

        while (true) {
            const cursorFilter =
                lastRowId == null ? '' : ` WHERE ${rowIdExpression} > ?`
            const params =
                lastRowId == null ? [pageSize] : [lastRowId, pageSize]
            const result = await executeOperation(
                [
                    {
                        sql: `SELECT ${rowIdExpression} AS ${quoteSqlIdentifier(
                            cursorAlias
                        )}, ${selectedColumns} FROM ${quotedTableName}${cursorFilter} ORDER BY ${
                            tableExportPlan.orderBy
                        } LIMIT ?;`,
                        params,
                    },
                ],
                dataSource,
                config
            )
            const rows = Array.isArray(result) ? result : []

            if (!rows.length) {
                return
            }

            for (const row of rows) {
                yield copyExportColumns(row, tableExportPlan.columns)
            }

            lastRowId = Number(rows.at(-1)?.[cursorAlias])

            if (rows.length < pageSize || !Number.isFinite(lastRowId)) {
                return
            }

            await yieldToRuntime()
        }
    }

    let offset = 0

    while (true) {
        const result = await executeOperation(
            [
                {
                    sql: `SELECT ${selectedColumns} FROM ${quotedTableName} ORDER BY ${tableExportPlan.orderBy} LIMIT ? OFFSET ?;`,
                    params: [pageSize, offset],
                },
            ],
            dataSource,
            config
        )
        const rows = Array.isArray(result) ? result : []

        if (!rows.length) {
            return
        }

        for (const row of rows) {
            yield row
        }

        offset += rows.length

        if (rows.length < pageSize) {
            return
        }

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
