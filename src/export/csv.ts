import { getTableData, createExportResponse } from './index'
import { createResponse } from '../utils'
import { DataSource } from '../types'
import { StarbaseDBConfiguration } from '../handler'

export async function exportTableToCsvRoute(
    tableName: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<Response> {
    try {
        const data = await getTableData(tableName, dataSource, config)

        if (data === null) {
            return createResponse(
                undefined,
                `Table '${tableName}' does not exist.`,
                404
            )
        }

        // Convert the result to CSV
        let csvContent = ''
        if (data.length > 0) {
            // Add headers
            csvContent += Object.keys(data[0]).join(',') + '\n'

            // Add data rows
            data.forEach((row: any) => {
                csvContent +=
                    Object.values(row)
                        .map((value) => {
                            if (
                                typeof value === 'string' &&
                                (value.includes(',') ||
                                    value.includes('"') ||
                                    value.includes('\n'))
                            ) {
                                return `"${value.replace(/"/g, '""')}"`
                            }
                            return value
                        })
                        .join(',') + '\n'
            })
        }

        return createExportResponse(
            csvContent,
            `${tableName}_export.csv`,
            'text/csv'
        )
    } catch (error: any) {
        console.error('CSV Export Error:', error)
        return createResponse(undefined, 'Failed to export table to CSV', 500)
    }
}
