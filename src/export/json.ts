import {
    getTableDataChunked,
    executeOperation,
    createStreamingExportResponse,
    writeChunk,
} from './index'
import { createResponse } from '../utils'
import { DataSource } from '../types'
import { StarbaseDBConfiguration } from '../handler'

const BREATHE_MS = 10

export async function exportTableToJsonRoute(
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
                await writeChunk(writer, '[\n')

                let isFirst = true
                for await (const chunk of getTableDataChunked(
                    tableName,
                    dataSource,
                    config,
                    1000
                )) {
                    for (const row of chunk) {
                        const prefix = isFirst ? '    ' : ',\n    '
                        isFirst = false
                        await writeChunk(
                            writer,
                            prefix + JSON.stringify(row)
                        )
                    }

                    // Breathing interval
                    if (BREATHE_MS > 0) {
                        await new Promise((r) => setTimeout(r, BREATHE_MS))
                    }
                }

                await writeChunk(writer, '\n]')
            },
            `${tableName}_export.json`,
            'application/json'
        )
    } catch (error: any) {
        console.error('JSON Export Error:', error)
        return createResponse(undefined, 'Failed to export table to JSON', 500)
    }
}
