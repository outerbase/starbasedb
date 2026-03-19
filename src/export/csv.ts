import {
    createStreamingExportResponse,
    forEachPage,
    tableExists,
} from './index'
import { createResponse } from '../utils'
import { DataSource } from '../types'
import { StarbaseDBConfiguration } from '../handler'

const encoder = new TextEncoder()

function csvValue(value: unknown): string {
    if (value === null || value === undefined) {
        return ''
    }

    const raw = String(value)
    if (raw.includes(',') || raw.includes('"') || raw.includes('\n')) {
        return `"${raw.replace(/"/g, '""')}"`
    }

    return raw
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

        let wroteHeader = false
        const stream = new ReadableStream<Uint8Array>({
            start: async (controller) => {
                try {
                    await forEachPage(
                        tableName,
                        dataSource,
                        config,
                        1000,
                        (rows) => {
                            if (!rows.length) {
                                return
                            }

                            if (!wroteHeader) {
                                controller.enqueue(
                                    encoder.encode(
                                        Object.keys(rows[0]).join(',') + '\n'
                                    )
                                )
                                wroteHeader = true
                            }

                            for (const row of rows) {
                                controller.enqueue(
                                    encoder.encode(
                                        Object.values(row)
                                            .map((value) => csvValue(value))
                                            .join(',') + '\n'
                                    )
                                )
                            }
                        }
                    )

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
