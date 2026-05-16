import { createResponse } from '../utils'
import { DataSource } from '../types'
import { StarbaseDBConfiguration } from '../handler'
import {
    createStreamingExportResponse,
    formatCsvValue,
    getTablePagePlan,
    iterateTableRows,
    tableExists,
} from './streaming'

async function* csvTableChunks(
    tableName: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): AsyncGenerator<string> {
    const pagePlan = await getTablePagePlan(tableName, dataSource, config)

    if (pagePlan.columns.length) {
        yield `${pagePlan.columns.map(formatCsvValue).join(',')}\n`
    }

    for await (const row of iterateTableRows(
        tableName,
        dataSource,
        config,
        pagePlan
    )) {
        yield `${pagePlan.columns.map((column) => formatCsvValue(row[column])).join(',')}\n`
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

        return createStreamingExportResponse(
            csvTableChunks(tableName, dataSource, config),
            `${tableName}_export.csv`,
            'text/csv'
        )
    } catch (error: any) {
        console.error('CSV Export Error:', error)
        return createResponse(undefined, 'Failed to export table to CSV', 500)
    }
}
