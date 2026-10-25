import {
    executeOperation,
    createExportResponse,
    EXPORT_PAGE_SIZE,
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
        // Verify if the table exists up front
        const tableExistsResult = await executeOperation(
            [
                {
                    sql: `SELECT name FROM sqlite_master WHERE type='table' AND name=?;`,
                    params: [tableName],
                },
            ],
            dataSource,
            config
        )

        if (!tableExistsResult || tableExistsResult.length === 0) {
            return createResponse(
                undefined,
                `Table '${tableName}' does not exist.`,
                404
            )
        }

        const encoder = new TextEncoder()
        const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
                try {
                    let offset = 0
                    let isFirstRow = true

                    while (true) {
                        const rows = await executeOperation(
                            [
                                {
                                    sql: `SELECT * FROM ${tableName} LIMIT ${EXPORT_PAGE_SIZE} OFFSET ${offset};`,
                                },
                            ],
                            dataSource,
                            config
                        )

                        if (!rows.length) {
                            if (isFirstRow) {
                                controller.enqueue(encoder.encode('[]'))
                            }
                            break
                        }

                        let chunk = ''
                        if (isFirstRow) {
                            chunk += '[\n'
                        }

                        for (const row of rows) {
                            const formattedRow = JSON.stringify(row, null, 4)
                                .split('\n')
                                .map((line) => '    ' + line)
                                .join('\n')

                            if (!isFirstRow) {
                                chunk += ',\n'
                            }
                            chunk += formattedRow
                            isFirstRow = false
                        }

                        controller.enqueue(encoder.encode(chunk))

                        if (rows.length < EXPORT_PAGE_SIZE) {
                            break
                        }
                        offset += EXPORT_PAGE_SIZE
                    }

                    if (!isFirstRow) {
                        controller.enqueue(encoder.encode('\n]'))
                    }

                    controller.close()
                } catch (error) {
                    controller.error(error)
                }
            },
        })

        return createExportResponse(
            stream,
            `${tableName}_export.json`,
            'application/json'
        )
    } catch (error: unknown) {
        console.error('JSON Export Error:', error)
        return createResponse(undefined, 'Failed to export table to JSON', 500)
    }
}
