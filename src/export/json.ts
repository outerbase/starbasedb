import {
    createExportStreamResponse,
    createTextStream,
    getTableDataBatches,
    tableExists,
} from './index'
import { createResponse } from '../utils'
import { DataSource } from '../types'
import { StarbaseDBConfiguration } from '../handler'

export async function exportTableToJsonRoute(
    tableName: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<Response> {
    try {
        const exists = await tableExists(tableName, dataSource, config)

        if (!exists) {
            return createResponse(
                undefined,
                `Table '${tableName}' does not exist.`,
                404
            )
        }

        const stream = createTextStream(async (enqueue) => {
            let isFirstRow = true

            enqueue('[')

            for await (const rows of getTableDataBatches(
                tableName,
                dataSource,
                config
            )) {
                for (const row of rows) {
                    enqueue(`${isFirstRow ? '' : ','}${JSON.stringify(row)}`)
                    isFirstRow = false
                }
            }

            enqueue(']')
        })

        return createExportStreamResponse(
            stream,
            `${tableName}_export.json`,
            'application/json'
        )
    } catch (error: any) {
        console.error('JSON Export Error:', error)
        return createResponse(undefined, 'Failed to export table to JSON', 500)
    }
}
