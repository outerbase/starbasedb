import {
    tableExists,
    forEachPage,
    createStreamingExportResponse,
} from '.'
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

                    await forEachPage(
                        tableName,
                        dataSource,
                        config,
                        async (rows) => {
                            let chunk = ''
                            for (const row of rows) {
                                if (!isFirstRow) {
                                    chunk += ',\n'
                                }
                                chunk += JSON.stringify(row, null, 4)
                                isFirstRow = false
                            }
                            controller.enqueue(encoder.encode(chunk))
                        }
                    )

                    controller.enqueue(encoder.encode('\n]\n'))
                    controller.close()
                } catch (err) {
                    controller.error(err)
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
