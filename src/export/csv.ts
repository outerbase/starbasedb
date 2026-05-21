import {
    createExportResponse,
    createTextStream,
    formatCsvValue,
    getTableColumns,
    getTableDataPage,
    iterateTableRows,
    resolveExportBatchSize,
    tableExists,
    type ExportOptions,
    type ExportRow,
} from './index'
import { createResponse } from '../utils'
import type { DataSource } from '../types'
import type { StarbaseDBConfiguration } from '../handler'

async function* createCsvExportIterator(opts: {
    tableName: string
    dataSource: DataSource
    config: StarbaseDBConfiguration
    batchSize: number
    columns: string[]
    firstPage: ExportRow[]
}): AsyncGenerator<string> {
    const { columns } = opts

    if (columns.length) {
        yield columns.map(formatCsvValue).join(',') + '\n'
    }

    for await (const row of iterateTableRows(opts)) {
        yield columns.map((column) => formatCsvValue(row[column])).join(',') +
            '\n'
    }
}

export async function exportTableToCsvRoute(
    tableName: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration,
    options: ExportOptions = {}
): Promise<Response> {
    try {
        const batchSize = resolveExportBatchSize(options.batchSize)
        const exists = await tableExists(tableName, dataSource, config)

        if (!exists) {
            return createResponse(
                undefined,
                `Table '${tableName}' does not exist.`,
                404
            )
        }

        const [columnsResult, firstPage] = await Promise.all([
            getTableColumns(tableName, dataSource, config),
            getTableDataPage(tableName, dataSource, config, batchSize, 0),
        ])
        const columns = columnsResult.length
            ? columnsResult
            : Object.keys(firstPage[0] ?? {})

        return createExportResponse(
            createTextStream(
                createCsvExportIterator({
                    tableName,
                    dataSource,
                    config,
                    batchSize,
                    columns,
                    firstPage,
                })
            ),
            `${tableName}_export.csv`,
            'text/csv'
        )
    } catch (error: any) {
        console.error('CSV Export Error:', error)
        return createResponse(undefined, 'Failed to export table to CSV', 500)
    }
}
