import {
    createExportResponse,
    createTextStream,
    executeOperation,
    formatSqlValue,
    getExportableTables,
    getTableColumns,
    iterateTableRows,
    quoteSqlIdentifier,
    resolveExportBatchSize,
    type ExportOptions,
} from '.'
import type { StarbaseDBConfiguration } from '../handler'
import type { DataSource } from '../types'
import { createResponse } from '../utils'

async function* createDatabaseDumpIterator(opts: {
    tables: string[]
    dataSource: DataSource
    config: StarbaseDBConfiguration
    batchSize: number
}): AsyncGenerator<string> {
    const { tables, dataSource, config, batchSize } = opts

    yield 'SQLite format 3\0'

    for (const table of tables) {
        const quotedTable = quoteSqlIdentifier(table)

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

        if (schemaResult.length && typeof schemaResult[0].sql === 'string') {
            const schemaSql = schemaResult[0].sql.trim().replace(/;$/, '')
            yield `\n-- Table: ${table}\n${schemaSql};\n\n`
        }

        const columns = await getTableColumns(table, dataSource, config)

        for await (const row of iterateTableRows({
            tableName: table,
            dataSource,
            config,
            batchSize,
        })) {
            const values = (
                columns.length
                    ? columns.map((column) => row[column])
                    : Object.values(row)
            ).map(formatSqlValue)
            yield `INSERT INTO ${quotedTable} VALUES (${values.join(', ')});\n`
        }

        yield '\n'
    }
}

export async function dumpDatabaseRoute(
    dataSource: DataSource,
    config: StarbaseDBConfiguration,
    options: ExportOptions = {}
): Promise<Response> {
    try {
        const batchSize = resolveExportBatchSize(options.batchSize)
        const tables = await getExportableTables(dataSource, config)

        return createExportResponse(
            createTextStream(
                createDatabaseDumpIterator({
                    tables,
                    dataSource,
                    config,
                    batchSize,
                })
            ),
            'database_dump.sql',
            'application/x-sqlite3'
        )
    } catch (error: any) {
        console.error('Database Dump Error:', error)
        return createResponse(undefined, 'Failed to create database dump', 500)
    }
}
