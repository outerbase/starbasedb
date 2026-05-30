import {
    executeOperation,
    getTableDataChunked,
    createStreamingExportResponse,
    createExportResponse,
} from './index'
import { createResponse } from '../utils'
import { DataSource } from '../types'
import { StarbaseDBConfiguration } from '../handler'

/**
 * Escapes a single CSV field value.
 */
function escapeCsvValue(value: unknown): string {
    if (value === null || value === undefined) {
        return ''
    }
    const str = String(value)
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`
    }
    return str
}

/**
 * Async generator that produces a CSV file as a stream of strings.
 *
 * Rows are fetched in chunks via LIMIT/OFFSET so that large tables do not
 * exhaust the Durable Object memory limit or breach the 30-second response
 * timeout.
 */
async function* generateCsvStream(
    tableName: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): AsyncGenerator<string> {
    let headerWritten = false

    for await (const chunk of getTableDataChunked(
        tableName,
        dataSource,
        config
    )) {
        if (!headerWritten && chunk.length > 0) {
            yield Object.keys(chunk[0]).join(',') + '\n'
            headerWritten = true
        }

        for (const row of chunk) {
            yield Object.values(row).map(escapeCsvValue).join(',') + '\n'
        }
    }
}

export async function exportTableToCsvRoute(
    tableName: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<Response> {
    try {
        // Verify the table exists before opening the stream
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
            `${tableName}_export.csv`,
            'text/csv',
            generateCsvStream(tableName, dataSource, config)
        )
    } catch (error: any) {
        console.error('CSV Export Error:', error)
        return createResponse(undefined, 'Failed to export table to CSV', 500)
    }
}
