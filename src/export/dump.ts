import { executeOperation } from '.'
import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { createResponse } from '../utils'

const MAX_RUNTIME_MS = 20 * 1000 // stop ~10s before 30s DO request limit
const PAGE_SIZE_BYTES = 4096     // SQLite default page size

export async function dumpDatabaseRoute(
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<Response> {
    const startTime = Date.now()

    try {
        // Estimate dump size before loading anything into memory.
        // pragma_page_count gives total pages; each page is 4096 bytes by default.
        let estimatedBytes = 0
        try {
            const pageResult = await executeOperation(
                [{ sql: 'SELECT page_count FROM pragma_page_count();' }],
                dataSource,
                config
            )
            const schemaResult = await executeOperation(
                [
                    {
                        sql: "SELECT SUM(LENGTH(sql)) FROM sqlite_master WHERE type IN ('table','index','trigger','view');",
                    },
                ],
                dataSource,
                config
            )
            const pageCount = pageResult?.[0]?.page_count ?? 0
            const schemaBytes = schemaResult?.[0]?.['SUM(LENGTH(sql))'] ?? 0
            estimatedBytes = pageCount * PAGE_SIZE_BYTES + schemaBytes * 2
        } catch (_) {
            // Estimate unavailable — proceed with caution
        }

        if (estimatedBytes > 100 * 1024 * 1024) {
            // >100 MB — too large for in-memory; user must chunk export
            return createResponse(
                undefined,
                'Database exceeds 100 MB — in-memory dump not supported. ' +
                    'Export individual tables via /export/csv/:tableName or /export/json/:tableName.',
                413
            )
        }

        // Get all table names
        const tablesResult = await executeOperation(
            [{ sql: "SELECT name FROM sqlite_master WHERE type='table';" }],
            dataSource,
            config
        )

        const tables = tablesResult.map((row: any) => row.name)
        let dumpContent = 'SQLite format 3\0'

        for (let i = 0; i < tables.length; i++) {
            const table = tables[i]

            // Time budget check between tables (not mid-INSERT)
            if (Date.now() - startTime > MAX_RUNTIME_MS) {
                return createResponse(
                    undefined,
                    `Dump time budget exceeded (${MAX_RUNTIME_MS / 1000}s) after ${i + 1}/${tables.length} tables. ` +
                        'Export individual tables via /export/csv/:tableName or /export/json/:tableName.',
                    413
                )
            }

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
                dumpContent += `\n-- Table: ${table}\n${schema};\n\n`
            }

            // Stream each table's rows with a per-table timeout
            const tableStart = Date.now()
            const MAX_TABLE_MS = 10 * 1000
            let rowCount = 0

            const dataResult = await executeOperation(
                [{ sql: `SELECT * FROM ${table};` }],
                dataSource,
                config
            )

            for (const row of dataResult) {
                // Individual row timeout guard
                if (Date.now() - tableStart > MAX_TABLE_MS || rowCount > 500_000) {
                    return createResponse(
                        undefined,
                        `Table "${table}" exceeds size limits (${rowCount}+ rows or ${MAX_TABLE_MS / 1000}s). ` +
                            'Use /export/csv/:tableName for large tables.',
                        413
                    )
                }

                const values = Object.values(row).map((value) =>
                    typeof value === 'string'
                        ? `'${value.replace(/'/g, "''")}'`
                        : value
                )
                dumpContent += `INSERT INTO ${table} VALUES (${values.join(', ')});\n`
                rowCount++
            }

            dumpContent += '\n'
        }

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
