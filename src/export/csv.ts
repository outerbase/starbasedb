import { executeOperation } from './index'
import { createResponse } from '../utils'
import { DataSource } from '../types'
import { StarbaseDBConfiguration } from '../handler'
import {
    DEFAULT_PAGE_SIZE,
    chunksToStream,
    iterateTableRows,
    streamingResponse,
} from './streaming'

/**
 * RFC-4180-ish quoting: only quote the field if it contains a delimiter,
 * quote, or newline; double internal quotes. Matches the previous buffered
 * implementation byte-for-byte.
 */
function csvField(value: unknown): string {
    if (value === null || value === undefined) return ''
    if (
        typeof value === 'string' &&
        (value.includes(',') || value.includes('"') || value.includes('\n'))
    ) {
        return `"${value.replace(/"/g, '""')}"`
    }
    return String(value)
}

async function* csvChunks(
    tableName: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration,
    pageSize: number = DEFAULT_PAGE_SIZE
): AsyncGenerator<string, void, void> {
    let headersEmitted = false
    for await (const row of iterateTableRows(
        tableName,
        dataSource,
        config,
        pageSize
    )) {
        if (!headersEmitted) {
            yield Object.keys(row).join(',') + '\n'
            headersEmitted = true
        }
        yield Object.values(row).map(csvField).join(',') + '\n'
    }
    // For an empty table we deliberately emit nothing — same observable
    // output as the buffered version, which used `csvContent = ''`.
}

export async function exportTableToCsvRoute(
    tableName: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<Response> {
    try {
        // Confirm table existence up front so 404 still returns synchronously
        // with a JSON body rather than a half-streamed file.
        const exists = await executeOperation(
            [
                {
                    sql: `SELECT name FROM sqlite_master WHERE type='table' AND name=?;`,
                    params: [tableName],
                },
            ],
            dataSource,
            config
        )
        if (!exists || exists.length === 0) {
            return createResponse(
                undefined,
                `Table '${tableName}' does not exist.`,
                404
            )
        }

        const stream = chunksToStream(csvChunks(tableName, dataSource, config))
        return streamingResponse(stream, `${tableName}_export.csv`, 'text/csv')
    } catch (error: any) {
        console.error('CSV Export Error:', error)
        return createResponse(undefined, 'Failed to export table to CSV', 500)
    }
}
