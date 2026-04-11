import {
    tableExists,
    getTableDataChunked,
    createStreamingExportResponse,
    CHUNK_SIZE,
} from './index'
import { createResponse } from '../utils'
import { DataSource } from '../types'
import { StarbaseDBConfiguration } from '../handler'

/**
 * Format a single value for CSV output.
 * Wraps in double quotes and escapes inner quotes when the value contains
 * commas, double quotes, or newlines.
 */
function formatCsvValue(value: unknown): string {
    if (value === null || value === undefined) {
        return ''
    }

    const str = String(value)
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`
    }
    return str
}

export async function exportTableToCsvRoute(
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
        let headerWritten = false

        const stream = new ReadableStream({
            async start(controller) {
                try {
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

                        let chunk = ''

                        // Write header row from first batch of results
                        if (!headerWritten) {
                            chunk += Object.keys(rows[0]).join(',') + '\n'
                            headerWritten = true
                        }

                        // Write data rows
                        for (const row of rows) {
                            chunk +=
                                Object.values(row)
                                    .map(formatCsvValue)
                                    .join(',') + '\n'
                        }

                        controller.enqueue(encoder.encode(chunk))

                        if (rows.length < CHUNK_SIZE) {
                            break
                        }

                        offset += CHUNK_SIZE
                    }

                    controller.close()
                } catch (error) {
                    controller.error(error)
                }
            },
        })

        return createStreamingExportResponse(
            stream,
            `${tableName}_export.csv`,
            'text/csv'
        )
    } catch (error: any) {
        console.error('CSV Export Error:', error)
        return createResponse(undefined, 'Failed to export table to CSV', 500)
    }
}
