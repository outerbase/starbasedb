import { executeOperation } from '.'
import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'

export const DEFAULT_EXPORT_PAGE_SIZE = 500

type TableColumn = {
    name: string
    pk?: number
}

type CursorColumn = {
    expression: string
    resultKey: string
}

export type TablePagePlan = {
    columns: string[]
    selectList: string
    orderBy: string[]
    cursorColumns: CursorColumn[]
    rowidAlias?: string
}

export function quoteSqlIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`
}

function arrayBufferToHex(buffer: ArrayBuffer): string {
    return Array.from(new Uint8Array(buffer))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('')
}

function isArrayBufferView(value: unknown): value is ArrayBufferView {
    return ArrayBuffer.isView(value)
}

function formatBinaryValue(value: ArrayBuffer | ArrayBufferView): string {
    const buffer = isArrayBufferView(value)
        ? value.buffer.slice(
              value.byteOffset,
              value.byteOffset + value.byteLength
          )
        : value

    return `X'${arrayBufferToHex(buffer)}'`
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

    if (value instanceof ArrayBuffer || isArrayBufferView(value)) {
        return formatBinaryValue(value)
    }

    return `'${String(value).replace(/'/g, "''")}'`
}

export function formatCsvValue(value: unknown): string {
    if (value === null || value === undefined) {
        return ''
    }

    const stringValue =
        value instanceof ArrayBuffer || isArrayBufferView(value)
            ? formatSqlValue(value)
            : String(value)

    if (/["\r\n,]/.test(stringValue)) {
        return `"${stringValue.replace(/"/g, '""')}"`
    }

    return stringValue
}

export function sanitizeExportFileName(fileName: string): string {
    return fileName.replace(/[\x00-\x1f"\\/:*?<>|]+/g, '_')
}

export async function yieldToRuntime(): Promise<void> {
    const scheduler = (
        globalThis as typeof globalThis & {
            scheduler?: { wait?: (delay: number) => Promise<void> }
        }
    ).scheduler

    if (scheduler?.wait) {
        await scheduler.wait(0)
        return
    }

    await new Promise((resolve) => setTimeout(resolve, 0))
}

export function createStreamingExportResponse(
    chunks: AsyncIterable<string>,
    fileName: string,
    contentType: string
): Response {
    const iterator = chunks[Symbol.asyncIterator]()
    const encoder = new TextEncoder()

    const stream = new ReadableStream<Uint8Array>({
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
        async cancel(reason) {
            if (iterator.return) {
                await iterator.return(reason)
            }
        },
    })

    return new Response(stream, {
        headers: {
            'Content-Type': contentType,
            'Content-Disposition': `attachment; filename="${sanitizeExportFileName(
                fileName
            )}"`,
        },
    })
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

    return result.map((row: { name: string }) => row.name)
}

export async function getTableSchema(
    tableName: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<string | undefined> {
    const result = await executeOperation(
        [
            {
                sql: "SELECT sql FROM sqlite_master WHERE type='table' AND name=?;",
                params: [tableName],
            },
        ],
        dataSource,
        config
    )

    const schema = result[0]?.sql
    return typeof schema === 'string' ? schema : undefined
}

export async function getTableColumns(
    tableName: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<TableColumn[]> {
    return executeOperation(
        [{ sql: `PRAGMA table_info(${quoteSqlIdentifier(tableName)});` }],
        dataSource,
        config
    )
}

function createRowidAlias(columns: TableColumn[]): string {
    const columnNames = new Set(columns.map((column) => column.name))
    let alias = '__starbasedb_export_rowid'

    while (columnNames.has(alias)) {
        alias = `${alias}_`
    }

    return alias
}

export async function getTablePagePlan(
    tableName: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<TablePagePlan | null> {
    if (!(await tableExists(tableName, dataSource, config))) {
        return null
    }

    const columns = await getTableColumns(tableName, dataSource, config)
    const columnNames = columns.map((column) => column.name)
    const primaryKeyColumns = columns
        .filter((column) => Number(column.pk ?? 0) > 0)
        .sort((left, right) => Number(left.pk ?? 0) - Number(right.pk ?? 0))

    if (primaryKeyColumns.length > 0) {
        const cursorColumns = primaryKeyColumns.map((column) => ({
            expression: quoteSqlIdentifier(column.name),
            resultKey: column.name,
        }))

        return {
            columns: columnNames,
            selectList: '*',
            orderBy: cursorColumns.map((column) => column.expression),
            cursorColumns,
        }
    }

    const rowidAlias = createRowidAlias(columns)

    return {
        columns: columnNames,
        selectList: `*, rowid AS ${quoteSqlIdentifier(rowidAlias)}`,
        orderBy: ['rowid'],
        cursorColumns: [{ expression: 'rowid', resultKey: rowidAlias }],
        rowidAlias,
    }
}

function buildKeysetCondition(
    cursorColumns: CursorColumn[],
    cursorValues: unknown[]
): { sql: string; params: unknown[] } {
    const clauses: string[] = []
    const params: unknown[] = []

    for (let index = 0; index < cursorColumns.length; index++) {
        const equalityColumns = cursorColumns.slice(0, index)
        const equality = equalityColumns
            .map((column) => `${column.expression} = ?`)
            .join(' AND ')
        const comparison = `${cursorColumns[index].expression} > ?`
        const clause = equality ? `(${equality} AND ${comparison})` : comparison

        clauses.push(`(${clause})`)
        params.push(...cursorValues.slice(0, index), cursorValues[index])
    }

    return { sql: clauses.join(' OR '), params }
}

function removeInternalCursorColumns(
    row: Record<string, unknown>,
    pagePlan: TablePagePlan
): Record<string, unknown> {
    if (!pagePlan.rowidAlias) {
        return row
    }

    const { [pagePlan.rowidAlias]: _rowid, ...exportedRow } = row
    return exportedRow
}

export async function* iterateTableRows(
    tableName: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration,
    options: {
        pagePlan?: TablePagePlan
        pageSize?: number
    } = {}
): AsyncGenerator<Record<string, unknown>> {
    const pagePlan =
        options.pagePlan ??
        (await getTablePagePlan(tableName, dataSource, config))

    if (!pagePlan) {
        return
    }

    const pageSize = options.pageSize ?? DEFAULT_EXPORT_PAGE_SIZE
    const quotedTableName = quoteSqlIdentifier(tableName)
    const orderBy = pagePlan.orderBy
        .map((expression) => `${expression} ASC`)
        .join(', ')
    let cursorValues: unknown[] | undefined
    let offset = 0

    while (true) {
        let params: unknown[] = [pageSize]
        let whereClause = ''
        let offsetClause = ''

        if (
            cursorValues?.length === pagePlan.cursorColumns.length &&
            cursorValues.every((value) => value !== null && value !== undefined)
        ) {
            const keyset = buildKeysetCondition(
                pagePlan.cursorColumns,
                cursorValues
            )
            whereClause = ` WHERE ${keyset.sql}`
            params = [...keyset.params, pageSize]
        } else if (offset > 0) {
            offsetClause = ' OFFSET ?'
            params = [pageSize, offset]
        }

        const pageRows = await executeOperation(
            [
                {
                    sql: `SELECT ${pagePlan.selectList} FROM ${quotedTableName}${whereClause} ORDER BY ${orderBy} LIMIT ?${offsetClause};`,
                    params: params as any[],
                },
            ],
            dataSource,
            config
        )

        if (pageRows.length === 0) {
            return
        }

        for (const row of pageRows as Record<string, unknown>[]) {
            yield removeInternalCursorColumns(row, pagePlan)
        }

        if (pageRows.length < pageSize) {
            return
        }

        const lastRow = pageRows[pageRows.length - 1] as Record<string, unknown>
        cursorValues = pagePlan.cursorColumns.map(
            (column) => lastRow[column.resultKey]
        )
        offset += pageSize
        await yieldToRuntime()
    }
}

export async function* sqlDumpChunks(
    tables: string[],
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): AsyncGenerator<string> {
    yield 'SQLite format 3\0'

    for (const tableName of tables) {
        const schema = await getTableSchema(tableName, dataSource, config)
        const pagePlan = await getTablePagePlan(tableName, dataSource, config)

        if (!pagePlan) {
            continue
        }

        if (schema) {
            const normalizedSchema = schema.trim().replace(/;+\s*$/, '')
            yield `\n-- Table: ${tableName}\n${normalizedSchema};\n\n`
        }

        const quotedTableName = quoteSqlIdentifier(tableName)

        for await (const row of iterateTableRows(
            tableName,
            dataSource,
            config,
            {
                pagePlan,
            }
        )) {
            const values = pagePlan.columns.map((columnName) =>
                formatSqlValue(row[columnName])
            )
            yield `INSERT INTO ${quotedTableName} VALUES (${values.join(', ')});\n`
        }

        yield '\n'
    }
}

export async function* csvTableChunks(
    tableName: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration,
    pagePlan: TablePagePlan
): AsyncGenerator<string> {
    if (pagePlan.columns.length === 0) {
        return
    }

    yield `${pagePlan.columns.map(formatCsvValue).join(',')}\n`

    for await (const row of iterateTableRows(tableName, dataSource, config, {
        pagePlan,
    })) {
        yield `${pagePlan.columns
            .map((columnName) => formatCsvValue(row[columnName]))
            .join(',')}\n`
    }
}

export async function* jsonTableChunks(
    tableName: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration,
    pagePlan: TablePagePlan
): AsyncGenerator<string> {
    let isFirstRow = true
    yield '['

    for await (const row of iterateTableRows(tableName, dataSource, config, {
        pagePlan,
    })) {
        yield `${isFirstRow ? '' : ','}${JSON.stringify(row, null, 4)}`
        isFirstRow = false
    }

    yield ']'
}
