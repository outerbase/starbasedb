import { EXPORT_PAGE_SIZE, getTableDataPage, tableExists } from './index'
import { createResponse } from '../utils'
import { DataSource } from '../types'
import { StarbaseDBConfiguration } from '../handler'

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

        const encoder = new TextEncoder()
        const stream = new ReadableStream({
            async start(controller) {
                controller.enqueue(encoder.encode('['))

                let offset = 0
                let isFirstRow = true
                let hasMoreRows = true

                while (hasMoreRows) {
                    const dataResult = await getTableDataPage(
                        tableName,
                        offset,
                        dataSource,
                        config
                    )

                    for (const row of dataResult) {
                        controller.enqueue(
                            encoder.encode(
                                `${isFirstRow ? '' : ','}${JSON.stringify(row)}`
                            )
                        )
                        isFirstRow = false
                    }

                    hasMoreRows = dataResult.length === EXPORT_PAGE_SIZE
                    offset += EXPORT_PAGE_SIZE

                    if (hasMoreRows) {
                        await new Promise((resolve) => setTimeout(resolve, 0))
                    }
                }

                controller.enqueue(encoder.encode(']'))
                controller.close()
            },
        })

        return new Response(stream, {
            headers: {
                'Content-Type': 'application/json',
                'Content-Disposition': `attachment; filename="${tableName}_export.json"`,
            },
        })
    } catch (error: any) {
        console.error('JSON Export Error:', error)
        return createResponse(undefined, 'Failed to export table to JSON', 500)
    }
}
