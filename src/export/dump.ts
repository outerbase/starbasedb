import { executeOperation } from '.'
import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { createResponse } from '../utils'
import {
    DEFAULT_PAGE_SIZE,
    breathe,
    chunksToStream,
    iterateTableRows,
    streamingResponse,
} from './streaming'

/**
 * Format a single value for inclusion in a SQL `INSERT ... VALUES (...)`
 * literal. Mirrors the previous (buffered) implementation's escaping rules so
 * the on-the-wire format is byte-for-byte identical for callers that diff
 * dumps; the only behavioural change is that the body now streams instead of
 * being buffered.
 */
function formatSqlValue(value: unknown): string {
    if (value === null || value === undefined) return 'NULL'
    if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`
    if (typeof value === 'number' || typeof value === 'bigint')
        return String(value)
    if (typeof value === 'boolean') return value ? '1' : '0'
    // Fallback: JSON-encode complex types (BLOB-as-buffer, etc.) wrapped in a
    // string literal — better than emitting `[object Object]`.
    return `'${JSON.stringify(value).replace(/'/g, "''")}'`
}

async function* dumpChunks(
    dataSource: DataSource,
    config: StarbaseDBConfiguration,
    pageSize: number = DEFAULT_PAGE_SIZE
): AsyncGenerator<string, void, void> {
    yield 'SQLite format 3\0'

    const tablesResult = await executeOperation(
        [{ sql: "SELECT name FROM sqlite_master WHERE type='table';" }],
        dataSource,
        config
    )
    const tables: string[] = tablesResult.map((row: any) => row.name)

    for (const table of tables) {
        const schemaResult = await executeOperation(
            [
                {
                    sql: `SELECT sql FROM sqlite_master WHERE type='table' AND name=?;`,
                    params: [table],
                },
            ],
            dataSource,
            config
        )

        if (schemaResult.length) {
            yield `\n-- Table: ${table}\n${schemaResult[0].sql};\n\n`
        }

        for await (const row of iterateTableRows(
            table,
            dataSource,
            config,
            pageSize
        )) {
            const values = Object.values(row).map(formatSqlValue)
            yield `INSERT INTO ${table} VALUES (${values.join(', ')});\n`
        }

        yield '\n'
        // Yield once per table boundary too, in case a table happened to fit
        // in a single page (no inter-page breathe would have fired).
        await breathe()
    }
}

export async function dumpDatabaseRoute(
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<Response> {
    try {
        const stream = chunksToStream(dumpChunks(dataSource, config))
        return streamingResponse(
            stream,
            'database_dump.sql',
            'application/x-sqlite3'
        )
    } catch (error: any) {
        console.error('Database Dump Error:', error)
        return createResponse(undefined, 'Failed to create database dump', 500)
    }
}
