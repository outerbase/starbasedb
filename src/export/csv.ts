import {
    getTableDataChunked,
    executeOperation,
    createStreamingExportResponse,
    writeChunk,
    createExportResponse,
} from './index'
import { createResponse } from '../utils'
import { DataSource } from '../types'
import { StarbaseDBConfiguration } from '../handler'

const BREATHE_MS = 10

function formatCsvRow(row: any): string {
    return Object.values(row)
        .map((value) => {
            if (
                typeof value === 'string' &&
                (value.includes(',') ||
                    value.includes('"') ||
                    value.includes('\n'))
            ) {
                return `"${value.replace(/"/g, '""')}"`
            }
            return value === null ? '' : value
        })
        .join(',')
}

export async function exportTableToCsvRoute(
    tableName: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<Response> {
    try {
        // Verify table exists
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

        return createStreamingExportResponse(
            async (writer) => {
                let headersWritten = false

                for await (const chunk of getTableDataChunked(
                    tableName,
                    dataSource,
                    config,
                    1000
                )) {
                    if (chunk.length === 0) continue

                    // Write CSV headers from first row of first chunk
                    if (!headersWritten) {
                        await writeChunk(
                            writer,
                            Object.keys(chunk[0]).join(',') + '\n'
                        )
                        headersWritten = true
                    }

                    // Write rows
                    let batchContent = ''
                    for (const row of chunk) {
                        batchContent += formatCsvRow(row) + '\n'
                    }
                    await writeChunk(writer, batchContent)

                    // Breathing interval
                    if (BREATHE_MS > 0) {
                        await new Promise((r) => setTimeout(r, BREATHE_MS))
                    }
                }
            },
            `${tableName}_export.csv`,
            'text/csv'
        )
    } catch (error: any) {
        console.error('CSV Export Error:', error)
        return createResponse(undefined, 'Failed to export table to CSV', 500)
    }
}
