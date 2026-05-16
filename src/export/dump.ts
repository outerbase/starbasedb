import { executeOperation } from '.'
import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { createResponse } from '../utils'
import {
    createStreamingExportResponse,
    formatSqlValue,
    getTableExportPlan,
    iterateTableRows,
    quoteSqlIdentifier,
    TableExportPlan,
} from './streaming'

type TableDumpContext = {
    name: string
    schema?: string
    exportPlan: TableExportPlan
}

async function* dumpDatabaseChunks(
    tables: TableDumpContext[],
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): AsyncGenerator<string> {
    yield 'PRAGMA foreign_keys=OFF;\nBEGIN TRANSACTION;\n'

    for (const table of tables) {
        if (table.schema) {
            const normalizedSchema = table.schema.trim().replace(/;+\s*$/, '')
            yield `\n-- Table: ${table.name}\n${normalizedSchema};\n\n`
        }

        const quotedTableName = quoteSqlIdentifier(table.name)

        for await (const row of iterateTableRows(
            table.name,
            dataSource,
            config,
            undefined,
            table.exportPlan
        )) {
            const values = Object.values(row).map(formatSqlValue)
            yield `INSERT INTO ${quotedTableName} VALUES (${values.join(
                ', '
            )});\n`
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
        // Get all table names
        const tablesResult = await executeOperation(
            [{ sql: "SELECT name FROM sqlite_master WHERE type='table';" }],
            dataSource,
            config
        )

        const tableNames = tablesResult
            .map((row: any) => row.name)
            .filter((name: unknown): name is string => typeof name === 'string')
        const tables: TableDumpContext[] = []

        for (const table of tableNames) {
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
            const schema =
                typeof schemaResult[0]?.sql === 'string'
                    ? schemaResult[0].sql
                    : undefined

            tables.push({
                name: table,
                schema,
                exportPlan: await getTableExportPlan(
                    table,
                    dataSource,
                    config,
                    schema
                ),
            })
        }

        return createStreamingExportResponse(
            dumpDatabaseChunks(tables, dataSource, config),
            'database_dump.sql',
            'application/sql; charset=utf-8'
        )
    } catch (error: any) {
        console.error('Database Dump Error:', error)
        return createResponse(undefined, 'Failed to create database dump', 500)
    }
}
