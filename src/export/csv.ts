import {
    createExportStreamResponse,
    createTextStream,
    getTableDataBatches,
    tableExists,
} from './index'
import { createResponse } from '../utils'
import { DataSource } from '../types'
import { StarbaseDBConfiguration } from '../handler'

function escapeCsvValue(value: unknown): string {
    const stringValue =
        value === null || value === undefined ? '' : String(value)

    if (
        stringValue.includes(',') ||
        stringValue.includes('"') ||
        stringValue.includes('\n')
    ) {
        return `"${stringValue.replace(/"/g, '""')}"`
    }

    return stringValue
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

        const stream = createTextStream(async (enqueue) => {
            let hasHeader = false

            for await (const rows of getTableDataBatches(
                tableName,
                dataSource,
                config
            )) {
                if (!hasHeader && rows.length > 0) {
                    enqueue(
                        Object.keys(rows[0]).map(escapeCsvValue).join(',') +
                            '\n'
                    )
                    hasHeader = true
                }

                for (const row of rows) {
                    enqueue(
                        Object.values(row).map(escapeCsvValue).join(',') + '\n'
                    )
                }
            }
        })

        return createExportStreamResponse(
            stream,
            `${tableName}_export.csv`,
            'text/csv'
        )
    } catch (error: any) {
        console.error('CSV Export Error:', error)
        return createResponse(undefined, 'Failed to export table to CSV', 500)
    }
}
