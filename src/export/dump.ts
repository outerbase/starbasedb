import { executeOperation } from '.'
import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { createResponse } from '../utils'
import {
    createStreamingExportResponse,
    formatSqlValue,
    iterateTableRows,
    quoteSqlIdentifier,
} from './streaming'

async function* dumpDatabaseChunks(
    tables: string[],
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): AsyncGenerator<string> {
    yield 'SQLite format 3\0'

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
            const schema = schemaResult[0].sql
            yield `\n-- Table: ${table}\n${schema};\n\n`
        }

        const quotedTableName = quoteSqlIdentifier(table)

        for await (const row of iterateTableRows(table, dataSource, config)) {
            const values = Object.values(row).map(formatSqlValue)
            yield `INSERT INTO ${quotedTableName} VALUES (${values.join(', ')});\n`
        }

        yield '\n'
    }
}

export async function dumpDatabaseRoute(
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<Response> {
    try {
        // Get all table names
        const tablesResult = await executeOperation(
            [{ sql: "SELECT name FROM sqlite_master WHERE type='table';" }],
            dataSource,
            config
        )

        const tables = tablesResult.map((row: any) => row.name)

        return createStreamingExportResponse(
            dumpDatabaseChunks(tables, dataSource, config),
            'database_dump.sql',
            'application/x-sqlite3'
        )
    } catch (error: any) {
        console.error('Database Dump Error:', error)
        return createResponse(undefined, 'Failed to create database dump', 500)
    }
}
