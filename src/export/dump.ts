import { executeOperation } from '.'
import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { createResponse } from '../utils'

const BATCH_SIZE = 500

function escapeValue(value: unknown): string {
    if (value === null || value === undefined) return 'NULL'
    if (typeof value === 'boolean') return value ? '1' : '0'
    if (typeof value === 'number' || typeof value === 'bigint')
        return String(value)
    return `'${String(value).replace(/'/g, "''")}'`
}

function quoteIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`
}

export async function dumpDatabaseRoute(
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<Response> {
    let tables: { name: string; sql: string | null }[]

    try {
        const tablesResult = await executeOperation(
            [
                {
                    sql: `SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name;`,
                },
            ],
            dataSource,
            config
        )
        tables = tablesResult.map((row: any) => ({
            name: row.name as string,
            sql: (row.sql as string | null) ?? null,
        }))
    } catch (error: any) {
        console.error('Database Dump Error:', error)
        return createResponse(undefined, 'Failed to create database dump', 500)
    }

    const encoder = new TextEncoder()

    const stream = new ReadableStream({
        async start(controller) {
            function write(text: string) {
                controller.enqueue(encoder.encode(text))
            }

            try {
                write('BEGIN TRANSACTION;\n\n')

                for (const table of tables) {
                    const quotedTable = quoteIdentifier(table.name)

                    if (table.sql) {
                        write(`${table.sql};\n\n`)
                    }

                    const schemaRows = await executeOperation(
                        [{ sql: `PRAGMA table_info(${quotedTable});` }],
                        dataSource,
                        config
                    )

                    const columns = schemaRows.map((r: any) => r.name as string)
                    const quotedColumns = columns
                        .map(quoteIdentifier)
                        .join(', ')

                    let offset = 0

                    while (true) {
                        const batch = await executeOperation(
                            [
                                {
                                    sql: `SELECT * FROM ${quotedTable} ORDER BY rowid LIMIT ${BATCH_SIZE} OFFSET ${offset};`,
                                },
                            ],
                            dataSource,
                            config
                        )

                        for (const row of batch) {
                            const values = columns
                                .map((col) =>
                                    escapeValue((row as any)[col])
                                )
                                .join(', ')
                            write(
                                `INSERT INTO ${quotedTable} (${quotedColumns}) VALUES (${values});\n`
                            )
                        }

                        offset += batch.length

                        await new Promise<void>((resolve) =>
                            setTimeout(resolve, 0)
                        )

                        if (batch.length < BATCH_SIZE) break
                    }

                    write('\n')
                }

                write('COMMIT;\n')
                controller.close()
            } catch (err: any) {
                console.error('Database Dump Stream Error:', err)
                controller.error(err)
            }
        },
    })

    return new Response(stream, {
        status: 200,
        headers: {
            'Content-Type': 'application/x-sql',
            'Content-Disposition':
                'attachment; filename="database_dump.sql"',
        },
    })
}