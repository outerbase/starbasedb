import {
    createExportResponse,
    createTextStream,
    iterateTableRows,
    getTableDataPage,
    resolveExportBatchSize,
    tableExists,
    type ExportOptions,
    type ExportRow,
} from './index'
import { createResponse } from '../utils'
import type { DataSource } from '../types'
import type { StarbaseDBConfiguration } from '../handler'

async function* createJsonExportIterator(opts: {
    tableName: string
    dataSource: DataSource
    config: StarbaseDBConfiguration
    batchSize: number
    firstPage: ExportRow[]
}): AsyncGenerator<string> {
    let hasRows = false

    yield '['

    for await (const row of iterateTableRows(opts)) {
        yield `${hasRows ? ',' : ''}\n    ${JSON.stringify(row)}`
        hasRows = true
    }

    if (hasRows) {
        yield '\n'
    }

    yield ']'
}

export async function exportTableToJsonRoute(
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

        const firstPage = await getTableDataPage(
            tableName,
            dataSource,
            config,
            batchSize,
            0
        )

        return createExportResponse(
            createTextStream(
                createJsonExportIterator({
                    tableName,
                    dataSource,
                    config,
                    batchSize,
                    firstPage,
                })
            ),
            `${tableName}_export.json`,
            'application/json'
        )
    } catch (error: any) {
        console.error('JSON Export Error:', error)
        return createResponse(undefined, 'Failed to export table to JSON', 500)
    }
}
