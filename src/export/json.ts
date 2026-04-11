import {
    tableExists,
    getTableDataChunked,
    createStreamingExportResponse,
    CHUNK_SIZE,
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

        const encoder = new TextEncoder()
        let isFirstRow = true

        const stream = new ReadableStream({
            async start(controller) {
                try {
                    controller.enqueue(encoder.encode('[\n'))

                    let offset = 0

                    while (true) {
                        const rows = await getTableDataChunked(
                            tableName,
                            offset,
                            CHUNK_SIZE,
                            dataSource,
                            config
                        )

                        if (!rows || rows.length === 0) {
                            break
                        }

                        for (const row of rows) {
                            if (!isFirstRow) {
                                controller.enqueue(encoder.encode(',\n'))
                            }
                            controller.enqueue(
                                encoder.encode('    ' + JSON.stringify(row))
                            )
                            isFirstRow = false
                        }

                        if (rows.length < CHUNK_SIZE) {
                            break
                        }

                        offset += CHUNK_SIZE
                    }

                    controller.enqueue(encoder.encode('\n]'))
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
