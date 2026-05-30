import {
    executeOperation,
    getTableDataChunked,
    createStreamingExportResponse,
} from '.'
import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { createResponse } from '../utils'

/**
 * Escapes a single SQL value for use inside an INSERT statement.
 */
function escapeSqlValue(value: unknown): string {
    if (value === null || value === undefined) {
        return 'NULL'
    }
    if (typeof value === 'number' || typeof value === 'bigint') {
        return String(value)
    }
    if (value instanceof Uint8Array || ArrayBuffer.isView(value)) {
        // Encode binary data as a SQLite hex literal: X'deadbeef'
        const hex = Array.from(value as Uint8Array)
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('')
        return `X'${hex}'`
    }
    // Default: treat as a string and escape single-quotes
    return `'${String(value).replace(/'/g, "''")}'`
}

/**
 * Async generator that produces a complete SQL dump as a stream of strings.
 *
 * Instead of loading every table into memory before writing the response,
 * we iterate through each table's rows in chunks (LIMIT/OFFSET) and yield
 * each INSERT statement as soon as it is ready.  This prevents the worker
 * from hitting the Cloudflare Durable Objects 1 GB memory limit or the
 * 30-second request timeout window on large databases.
 *
 * Note: the `tables` array is pre-fetched by the caller so that any failure
 * in the initial metadata query can be caught and turned into a 500 response
 * before the streaming body is opened.
 */
async function* generateDumpStream(
    tables: string[],
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): AsyncGenerator<string> {
    yield '-- StarbaseDB SQL Dump\n'
    yield `-- Generated: ${new Date().toISOString()}\n\n`
    yield 'PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\n\n'

    for (const table of tables) {
        // Emit the CREATE TABLE statement
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

        if (schemaResult.length && schemaResult[0].sql) {
            yield `-- Table: ${table}\n`
            yield `DROP TABLE IF EXISTS ${table};\n`
            yield `${schemaResult[0].sql};\n\n`
        }

        // Stream INSERT statements in chunks to avoid memory exhaustion
        for await (const chunk of getTableDataChunked(
            table,
            dataSource,
            config
        )) {
            for (const row of chunk) {
                const values = Object.values(row).map(escapeSqlValue)
                yield `INSERT INTO ${table} VALUES (${values.join(', ')});\n`
            }
        }

        yield '\n'
    }

    yield 'COMMIT;\n'
}

export async function dumpDatabaseRoute(
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<Response> {
    try {
        // Retrieve table list eagerly so any error here can be converted to a
        // proper 500 response before the streaming body is opened.
        const tablesResult = await executeOperation(
            [
                {
                    sql: "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'tmp_%';",
                },
            ],
            dataSource,
            config
        )

        const tables: string[] = tablesResult.map((row: any) => row.name)

        return createStreamingExportResponse(
            'database_dump.sql',
            'application/sql',
            generateDumpStream(tables, dataSource, config)
        )
    } catch (error: any) {
        console.error('Database Dump Error:', error)
        return createResponse(undefined, 'Failed to create database dump', 500)
    }
}
