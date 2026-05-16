import { createResponse } from '../utils'
import { DataSource } from '../types'
import { StarbaseDBConfiguration } from '../handler'
import {
    createStreamingExportResponse,
    formatCsvValue,
    getTableExportPlan,
    iterateTableRows,
    tableExists,
    TableExportPlan,
} from './streaming'

async function* csvTableChunks(
    tableName: string,
    columns: string[],
    dataSource: DataSource,
    config: StarbaseDBConfiguration,
    exportPlan: TableExportPlan
): AsyncGenerator<string> {
    if (columns.length) {
        yield `${columns.map(formatCsvValue).join(',')}\n`
    }

    for await (const row of iterateTableRows(
        tableName,
        dataSource,
        config,
        undefined,
        exportPlan
    )) {
        yield `${columns.map((column) => formatCsvValue(row[column])).join(',')}\n`
    }
}

export async function exportTableToCsvRoute(
    tableName: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<Response> {
    try {
        if (!(await tableExists(tableName, dataSource, config))) {
            return createResponse(
                undefined,
                `Table '${tableName}' does not exist.`,
                404
            )
        }

        const exportPlan = await getTableExportPlan(
            tableName,
            dataSource,
            config
        )
        const columns = exportPlan.columns

        return createStreamingExportResponse(
            csvTableChunks(tableName, columns, dataSource, config, exportPlan),
            `${tableName}_export.csv`,
            'text/csv'
        )
    } catch (error: any) {
        console.error('CSV Export Error:', error)
        return createResponse(undefined, 'Failed to export table to CSV', 500)
    }
}
