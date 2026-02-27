import {
    tableExists,
    forEachPage,
    createStreamingExportResponse,
} from '.'
import { createResponse } from '../utils'
import { DataSource } from '../types'
import { StarbaseDBConfiguration } from '../handler'

function escapeCsvValue(value: unknown): string {
    if (value === null || value === undefined) return ''
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
                    await forEachPage(
                        tableName,
                        dataSource,
                        config,
                        async (rows, isFirstPage) => {
                            let chunk = ''

                            // Write CSV header from the first page
                            if (isFirstPage && !headerWritten && rows.length > 0) {
                                chunk += Object.keys(rows[0])
                                    .map(escapeCsvValue)
                                    .join(',') + '\n'
                                headerWritten = true
                            }

                            for (const row of rows) {
                                chunk += Object.values(row)
                                    .map(escapeCsvValue)
                                    .join(',') + '\n'
                            }

                            controller.enqueue(encoder.encode(chunk))
                        }
                    )

                    controller.close()
                } catch (err) {
                    controller.error(err)
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
