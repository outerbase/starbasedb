import * as exportModule from './index'
import { createResponse } from '../utils'
import { DataSource } from '../types'
import { StarbaseDBConfiguration } from '../handler'

export interface CsvExportOptions {
    batchSize?: number
    breathingIntervalMs?: number
}

function formatCsvValue(value: unknown): string {
    if (value === null || value === undefined) {
        return ''
    }
    if (
        typeof value === 'string' &&
        (value.includes(',') ||
            value.includes('"') ||
            value.includes('\n') ||
            value.includes('\r'))
    ) {
        return `"${value.replace(/"/g, '""')}"`
    }
    return String(value)
}

export async function exportTableToCsvRoute(
    tableName: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration,
    options: CsvExportOptions = {}
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

            let csvContent = ''
            if (data.length > 0) {
                csvContent += Object.keys(data[0]).join(',') + '\n'
                data.forEach((row: any) => {
                    csvContent +=
                        Object.values(row).map(formatCsvValue).join(',') + '\n'
                })
            }

            return exportModule.createExportResponse(
                csvContent,
                `${tableName}_export.csv`,
                'text/csv'
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
                    let headerWritten = false

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
                        if (!headerWritten) {
                            chunk += Object.keys(rows[0]).join(',') + '\n'
                            headerWritten = true
                        }

                        for (const row of rows) {
                            chunk +=
                                Object.values(row)
                                    .map(formatCsvValue)
                                    .join(',') + '\n'
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

                    controller.close()
                } catch (streamError) {
                    controller.error(streamError)
                }
            },
        })

        return exportModule.createExportResponse(
            stream,
            `${tableName}_export.csv`,
            'text/csv'
        )
    } catch (error: any) {
        console.error('CSV Export Error:', error)
        return createResponse(undefined, 'Failed to export table to CSV', 500)
    }
}
