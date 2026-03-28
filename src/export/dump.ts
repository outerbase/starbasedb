import { executeOperation } from '.'
import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { createResponse } from '../utils'

export async function dumpDatabaseRoute(
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<Response> {
    try {
        // Pre-fetch table names to validate DB connection before streaming
        const tablesResult = await executeOperation(
            [{ sql: "SELECT name FROM sqlite_master WHERE type='table';" }],
            dataSource,
            config
        )

        const stream = new ReadableStream({
            async start(controller) {
                try {
                    const tables = tablesResult?.map((row: any) => row.name) || []
                    const encoder = new TextEncoder()
                    
                    if (tables.length === 0) {
                        controller.enqueue(encoder.encode('SQLite format 3\0'))
                        controller.close()
                        return
                    }

                    controller.enqueue(encoder.encode('SQLite format 3\0\n'))

                    // Iterate through all tables
                    for (const table of tables) {
                        if (!table) continue;
                        
                        // Get table schema
                        const schemaResult = await executeOperation(
                            [
                                {
                                    sql: `SELECT sql FROM sqlite_master WHERE type='table' AND name=?;`,
                                    params: [table]
                                },
                            ],
                            dataSource,
                            config
                        )

                        let tableHasSchema = false;
                        if (schemaResult && schemaResult.length > 0 && schemaResult[0] && schemaResult[0].sql) {
                            const schema = schemaResult[0].sql
                            if (schema) {
                                controller.enqueue(encoder.encode(`\n-- Table: ${table}\n${schema};\n\n`))
                                tableHasSchema = true;
                            }
                        }

                        // Get table data
                        // Handle pagination for massive tables to prevent memory buildup
                        let offset = 0
                        const limit = 5000
                        while (true) {
                            const dataResult = await executeOperation(
                                [{ sql: `SELECT * FROM ${table} LIMIT ${limit} OFFSET ${offset};` }],
                                dataSource,
                                config
                            )
                            
                            if (!dataResult || dataResult.length === 0) break;

                            for (const row of dataResult) {
                                const values = Object.values(row).map((value) =>
                                    typeof value === 'string'
                                        ? `'${value.replace(/'/g, "''")}'`
                                        : value === null
                                        ? 'NULL'
                                        : value
                                )
                                controller.enqueue(encoder.encode(`INSERT INTO ${table} VALUES (${values.join(', ')});\n`))
                            }
                            
                            offset += limit
                            if (dataResult.length < limit) break;
                            
                            // Yield to the event loop to prevent durable object blocking
                            await new Promise(resolve => setTimeout(resolve, 5))
                        }

                        controller.enqueue(encoder.encode('\n'))
                    }
                    
                    controller.close()
                } catch (e) {
                    controller.error(e)
                }
            }
        })

        const headers = new Headers({
            'Content-Type': 'application/x-sqlite3',
            'Content-Disposition': 'attachment; filename="database_dump.sql"',
            'Transfer-Encoding': 'chunked'
        })

        return new Response(stream, { headers })
    } catch (error: any) {
        console.error('Database Dump Error:', error)
        return createResponse(undefined, 'Failed to create database dump', 500)
    }
}
