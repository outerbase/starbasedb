import { executeOperation } from '.'
import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { createResponse } from '../utils'
import {
    createStreamingExportResponse,
    formatSqlValue,
    getTablePagePlan,
    iterateTableRows,
    listExportableTables,
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
                    sql: "SELECT sql FROM sqlite_master WHERE type='table' AND name=?;",
                    params: [table],
                },
            ],
            dataSource,
            config
        )

        if (schemaResult.length) {
            yield `\n-- Table: ${table}\n${schemaResult[0].sql};\n\n`
        }

        const pagePlan = await getTablePagePlan(table, dataSource, config)
        const quotedTableName = quoteSqlIdentifier(table)

        for await (const row of iterateTableRows(
            table,
            dataSource,
            config,
            pagePlan
        )) {
            const values = pagePlan.columns.map((column) =>
                formatSqlValue(row[column])
            )
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
        const tables = await listExportableTables(dataSource, config)

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
