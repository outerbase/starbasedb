import {
    createExportStreamResponse,
    createTextStream,
    executeOperation,
    getTableDataBatches,
} from '.'
import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { createResponse } from '../utils'

function escapeSqlValue(value: unknown): string {
    if (value === null || value === undefined) {
        return 'NULL'
    }

    if (typeof value === 'string') {
        return `'${value.replace(/'/g, "''")}'`
    }

    return String(value)
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

        const stream = createTextStream(async (enqueue) => {
            enqueue('SQLite format 3\0') // SQLite file header

            // Iterate through all tables without building the full dump in memory.
            for (const table of tables) {
                // Get table schema
                const schemaResult = await executeOperation(
                    [
                        {
                            sql: `SELECT sql FROM sqlite_master WHERE type='table' AND name='${table}';`,
                        },
                    ],
                    dataSource,
                    config
                )

                if (schemaResult.length) {
                    const schema = schemaResult[0].sql
                    enqueue(`\n-- Table: ${table}\n${schema};\n\n`)
                }

                for await (const rows of getTableDataBatches(
                    table,
                    dataSource,
                    config
                )) {
                    for (const row of rows) {
                        const values = Object.values(row).map(escapeSqlValue)
                        enqueue(
                            `INSERT INTO ${table} VALUES (${values.join(', ')});\n`
                        )
                    }
                }

                enqueue('\n')
            }
        })

        return createExportStreamResponse(
            stream,
            'database_dump.sql',
            'application/x-sqlite3'
        )
    } catch (error: any) {
        console.error('Database Dump Error:', error)
        return createResponse(undefined, 'Failed to create database dump', 500)
    }
}
