import {
    executeOperation,
    getTableDataChunked,
    createStreamingExportResponse,
} from './index'
import { createResponse } from '../utils'
import { DataSource } from '../types'
import { StarbaseDBConfiguration } from '../handler'

/**
 * Async generator that produces a JSON array as a stream of strings.
 *
 * The JSON array is opened/closed manually so that individual row objects
 * can be serialised and emitted one chunk at a time, preventing the entire
 * table from being held in memory simultaneously.
 */
async function* generateJsonStream(
    tableName: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): AsyncGenerator<string> {
    yield '[\n'
    let firstRow = true

    for await (const chunk of getTableDataChunked(
        tableName,
        dataSource,
        config
    )) {
        for (const row of chunk) {
            if (!firstRow) {
                yield ',\n'
            }
            yield JSON.stringify(row, null, 4)
                .split('\n')
                .map((line) => '    ' + line)
                .join('\n')
            firstRow = false
        }
    }

    if (!firstRow) {
        yield '\n'
    }
    yield ']\n'
}

export async function exportTableToJsonRoute(
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
            `${tableName}_export.json`,
            'application/json',
            generateJsonStream(tableName, dataSource, config)
        )
    } catch (error: any) {
        console.error('JSON Export Error:', error)
        return createResponse(undefined, 'Failed to export table to JSON', 500)
    }
}
