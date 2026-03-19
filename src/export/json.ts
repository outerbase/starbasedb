import {
    createStreamingExportResponse,
    forEachPage,
    tableExists,
} from './index'
import { createResponse } from '../utils'
import { DataSource } from '../types'
import { StarbaseDBConfiguration } from '../handler'

const encoder = new TextEncoder()

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

        let isFirstRow = true
        const stream = new ReadableStream<Uint8Array>({
            start: async (controller) => {
                try {
                    controller.enqueue(encoder.encode('['))

                    await forEachPage(
                        tableName,
                        dataSource,
                        config,
                        1000,
                        (rows) => {
                            for (const row of rows) {
                                if (!isFirstRow) {
                                    controller.enqueue(encoder.encode(','))
                                }

                                controller.enqueue(
                                    encoder.encode(JSON.stringify(row))
                                )
                                isFirstRow = false
                            }
                        }
                    )

                    controller.enqueue(encoder.encode(']'))
                    controller.close()
                } catch (error) {
                    controller.error(error)
                }
            },
        })

        return createStreamingExportResponse(
            stream,
            `${tableName}_export.json`,
            'application/json'
        )
    } catch (error: any) {
        console.error('JSON Export Error:', error)
        return createResponse(undefined, 'Failed to export table to JSON', 500)
    }
}
