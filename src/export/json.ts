import { createResponse } from '../utils'
import { DataSource } from '../types'
import { StarbaseDBConfiguration } from '../handler'
import {
    createStreamingExportResponse,
    getTableExportPlan,
    iterateTableRows,
    tableExists,
    TableExportPlan,
} from './streaming'

async function* jsonTableChunks(
    tableName: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration,
    exportPlan: TableExportPlan
): AsyncGenerator<string> {
    let isFirstRow = true

    yield '['

    for await (const row of iterateTableRows(
        tableName,
        dataSource,
        config,
        undefined,
        exportPlan
    )) {
        yield `${isFirstRow ? '' : ','}\n${JSON.stringify(row, null, 4)}`
        isFirstRow = false
    }

    yield isFirstRow ? ']' : '\n]'
}

export async function exportTableToJsonRoute(
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

        return createStreamingExportResponse(
            jsonTableChunks(tableName, dataSource, config, exportPlan),
            `${tableName}_export.json`,
            'application/json'
        )
    } catch (error: any) {
        console.error('JSON Export Error:', error)
        return createResponse(undefined, 'Failed to export table to JSON', 500)
    }
}
