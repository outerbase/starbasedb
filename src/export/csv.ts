import { EXPORT_PAGE_SIZE, getTableDataPage, tableExists } from './index'
import { createResponse } from '../utils'
import { DataSource } from '../types'
import { StarbaseDBConfiguration } from '../handler'

function serializeCsvValue(value: unknown): string {
    if (value === null || value === undefined) {
        return ''
    }

    const stringValue = String(value)
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
                let offset = 0
                let wroteHeader = false
                let hasMoreRows = true

                while (hasMoreRows) {
                    const dataResult = await getTableDataPage(
                        tableName,
                        offset,
                        dataSource,
                        config
                    )

                    if (!wroteHeader && dataResult.length > 0) {
                        controller.enqueue(
                            encoder.encode(
                                Object.keys(dataResult[0]).join(',') + '\n'
                            )
                        )
                        wroteHeader = true
                    }

                    for (const row of dataResult) {
                        controller.enqueue(
                            encoder.encode(
                                Object.values(row)
                                    .map(serializeCsvValue)
                                    .join(',') + '\n'
                            )
                        )
                    }

                    hasMoreRows = dataResult.length === EXPORT_PAGE_SIZE
                    offset += EXPORT_PAGE_SIZE

                    if (hasMoreRows) {
                        await new Promise((resolve) => setTimeout(resolve, 0))
                    }
                }

                controller.close()
            },
        })

        return new Response(stream, {
            headers: {
                'Content-Type': 'text/csv',
                'Content-Disposition': `attachment; filename="${tableName}_export.csv"`,
            },
        })
    } catch (error: any) {
        console.error('CSV Export Error:', error)
        return createResponse(undefined, 'Failed to export table to CSV', 500)
    }
}
