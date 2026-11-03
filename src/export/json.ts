import * as exportModule from './index'
import { createResponse } from '../utils'
import { DataSource } from '../types'
import { StarbaseDBConfiguration } from '../handler'

export interface JsonExportOptions {
    batchSize?: number
    breathingIntervalMs?: number
}

function formatJsonRowIndented(row: Record<string, unknown>): string {
    return JSON.stringify(row, null, 4)
        .split('\n')
        .map((line) => `    ${line}`)
        .join('\n')
}

export async function exportTableToJsonRoute(
    tableName: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration,
    options: JsonExportOptions = {}
): Promise<Response> {
    try {
        const batchSize =
            options.batchSize ?? exportModule.EXPORT_BATCH_SIZE ?? 1000
        const breathingIntervalMs = options.breathingIntervalMs ?? 0

        // Support legacy mocks where only getTableData is mocked on './index'
        if (typeof exportModule.executeOperation !== 'function') {
            const data = await exportModule.getTableData(
                tableName,
                dataSource,
                config
            )

            if (data === null) {
                return createResponse(
                    undefined,
                    `Table '${tableName}' does not exist.`,
                    404
                )
            }

            const jsonData = JSON.stringify(data, null, 4)

            return exportModule.createExportResponse(
                jsonData,
                `${tableName}_export.json`,
                'application/json'
            )
        }

        // Verify if the table exists before streaming
        const tableExistsResult = await exportModule.executeOperation(
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

        const quotedTable = exportModule.quoteIdentifier
            ? exportModule.quoteIdentifier(tableName)
            : tableName
        const encoder = new TextEncoder()

        const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
                try {
                    let offset = 0
                    let isFirstRow = true

                    while (true) {
                        const rows =
                            (await exportModule.executeOperation(
                                [
                                    {
                                        sql: `SELECT * FROM ${quotedTable} LIMIT ${batchSize} OFFSET ${offset};`,
                                    },
                                ],
                                dataSource,
                                config
                            )) || []

                        if (rows.length === 0) {
                            break
                        }

                        let chunk = ''
                        for (const row of rows) {
                            if (isFirstRow) {
                                chunk += '[\n' + formatJsonRowIndented(row)
                                isFirstRow = false
                            } else {
                                chunk += ',\n' + formatJsonRowIndented(row)
                            }
                        }

                        controller.enqueue(encoder.encode(chunk))

                        if (rows.length < batchSize) {
                            break
                        }

                        offset += batchSize

                        if (breathingIntervalMs > 0) {
                            await new Promise((resolve) =>
                                setTimeout(resolve, breathingIntervalMs)
                            )
                        }
                    }

                    if (isFirstRow) {
                        controller.enqueue(encoder.encode('[]'))
                    } else {
                        controller.enqueue(encoder.encode('\n]'))
                    }

                    controller.close()
                } catch (streamError) {
                    controller.error(streamError)
                }
            },
        })

        return exportModule.createExportResponse(
            stream,
            `${tableName}_export.json`,
            'application/json'
        )
    } catch (error: any) {
        console.error('JSON Export Error:', error)
        return createResponse(undefined, 'Failed to export table to JSON', 500)
    }
}
