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
 * Stream a JSON array. We hand-assemble the `[`, `,` separators, and `]`
 * rather than calling `JSON.stringify` on the full result set; only one row's
 * worth of objects is ever in memory. Output is still a valid JSON document
 * — the structural commas only appear between rows.
 */
async function* jsonChunks(
    tableName: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration,
    pageSize: number = DEFAULT_PAGE_SIZE
): AsyncGenerator<string, void, void> {
    yield '['
    let first = true
    for await (const row of iterateTableRows(
        tableName,
        dataSource,
        config,
        pageSize
    )) {
        const encoded = JSON.stringify(row)
        if (first) {
            yield `\n    ${encoded}`
            first = false
        } else {
            yield `,\n    ${encoded}`
        }
    }
    yield first ? ']' : '\n]'
}

export async function exportTableToJsonRoute(
    tableName: string,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<Response> {
    try {
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

        const stream = chunksToStream(jsonChunks(tableName, dataSource, config))
        return streamingResponse(
            stream,
            `${tableName}_export.json`,
            'application/json'
        )
    } catch (error: any) {
        console.error('JSON Export Error:', error)
        return createResponse(undefined, 'Failed to export table to JSON', 500)
    }
}
