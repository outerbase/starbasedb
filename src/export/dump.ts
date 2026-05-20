import { executeOperation } from '.'
import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { createResponse } from '../utils'

const sqliteKeywords = new Set([
    'select',
    'from',
    'where',
    'table',
    'index',
    'insert',
    'values',
    'order',
    'group',
    'by',
    'limit',
    'offset',
    'join',
    'on',
    'and',
    'or',
])

function quoteSqlString(value: string) {
    return `'${value.replace(/'/g, "''")}'`
}

function formatIdentifier(identifier: string) {
    if (
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier) &&
        !sqliteKeywords.has(identifier.toLowerCase())
    ) {
        return identifier
    }

    return `"${identifier.replace(/"/g, '""')}"`
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
        let dumpContent = 'SQLite format 3\0' // SQLite file header

        // Iterate through all tables
        for (const table of tables) {
            // Get table schema
            const schemaResult = await executeOperation(
                [
                    {
                        sql: `SELECT sql FROM sqlite_master WHERE type='table' AND name=${quoteSqlString(table)};`,
                    },
                ],
                dataSource,
                config
            )

            if (schemaResult.length) {
                const schema = schemaResult[0].sql
                dumpContent += `\n-- Table: ${table}\n${schema};\n\n`
            }

            // Get table data
            const dataResult = await executeOperation(
                [{ sql: `SELECT * FROM ${formatIdentifier(table)};` }],
                dataSource,
                config
            )

            for (const row of dataResult) {
                const values = Object.values(row).map((value) =>
                    typeof value === 'string'
                        ? `'${value.replace(/'/g, "''")}'`
                        : value
                )
                dumpContent += `INSERT INTO ${formatIdentifier(table)} VALUES (${values.join(', ')});\n`
            }

            dumpContent += '\n'
        }

        // Create a Blob from the dump content
        const blob = new Blob([dumpContent], { type: 'application/x-sqlite3' })

        const headers = new Headers({
            'Content-Type': 'application/x-sqlite3',
            'Content-Disposition': 'attachment; filename="database_dump.sql"',
        })

        return new Response(blob, { headers })
    } catch (error: any) {
        console.error('Database Dump Error:', error)
        return createResponse(undefined, 'Failed to create database dump', 500)
    }
}
