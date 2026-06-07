import { getTableData, createExportResponse } from './index'
import { createResponse } from '../utils'
import { DataSource } from '../types'
import { StarbaseDBConfiguration } from '../handler'
import { CHUNK_SIZE } from './constants'

function escapeCsvValue(value: any): string {
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
    config: StarbaseDBConfiguration,
    limit?: number,
    offset?: number
): Promise<Response> {
    try {
        const data = await getTableData(tableName, dataSource, config, limit, offset)

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
            for (const row of data) {
                csvContent += Object.values(row).map(escapeCsvValue).join(',') + '\n'
            }
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

export async function exportTableToCsvStreamRoute(
    tableName: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<Response> {
    try {
        const firstChunk = await getTableData(tableName, dataSource, config, 1, 0)
        if (firstChunk === null) {
            return createResponse(undefined, `Table '${tableName}' does not exist.`, 404)
        }

        // Get column names from first row
        const cols = firstChunk.length > 0 ? Object.keys(firstChunk[0]) : []

        const stream = new ReadableStream({
            async start(controller) {
                try {
                    // Write CSV header
                    if (cols.length > 0) {
                        controller.enqueue(new TextEncoder().encode(cols.join(',') + '\n'))
                    }

                    let offset = 0
                    while (true) {
                        const chunk = await getTableData(tableName, dataSource, config, CHUNK_SIZE, offset)
                        if (!chunk || chunk.length === 0) break

                        let csvPart = ''
                        for (const row of chunk) {
                            csvPart += Object.values(row).map(escapeCsvValue).join(',') + '\n'
                        }
                        controller.enqueue(new TextEncoder().encode(csvPart))
                        offset += CHUNK_SIZE
                    }
                } catch (err: any) {
                    controller.error(err)
                    return
                }
                controller.close()
            }
        })

        const headers = new Headers({
            'Content-Type': 'text/csv',
            'Content-Disposition': `attachment; filename="${tableName}_export.csv"`,
            'Transfer-Encoding': 'chunked',
        })
        return new Response(stream, { headers })
    } catch (error: any) {
        console.error('CSV Export Error:', error)
        return createResponse(undefined, 'Failed to export table to CSV', 500)
    }
}
