import {
    executeOperation,
    createExportResponse,
    EXPORT_PAGE_SIZE,
} from './index'
import { createResponse } from '../utils'
import { DataSource } from '../types'
import { StarbaseDBConfiguration } from '../handler'

export async function exportTableToCsvRoute(
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
                    let headerWritten = false

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
                                    .map((value) => {
                                        if (
                                            typeof value === 'string' &&
                                            (value.includes(',') ||
                                                value.includes('"') ||
                                                value.includes('\n') ||
                                                value.includes('\r'))
                                        ) {
                                            return `"${value.replace(/"/g, '""')}"`
                                        }
                                        return value === null ||
                                            value === undefined
                                            ? ''
                                            : value
                                    })
                                    .join(',') + '\n'
                        }

                        controller.enqueue(encoder.encode(chunk))

                        if (rows.length < EXPORT_PAGE_SIZE) {
                            break
                        }
                        offset += EXPORT_PAGE_SIZE
                    }

                    controller.close()
                } catch (error) {
                    controller.error(error)
                }
            },
        })

        return createExportResponse(
            stream,
            `${tableName}_export.csv`,
            'text/csv'
        )
    } catch (error: unknown) {
        console.error('CSV Export Error:', error)
        return createResponse(undefined, 'Failed to export table to CSV', 500)
    }
}
