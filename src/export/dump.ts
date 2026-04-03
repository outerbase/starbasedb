import { executeOperation } from '.'
import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { createResponse } from '../utils'

export async function dumpDatabaseRoute(
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<Response> {
    try {
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const encoder = new TextEncoder();

        // Proses streaming berjalan di background
        (async () => {
            try {
                // 1. Ambil semua nama tabel
                const tablesResult = await executeOperation(
                    [{ sql: "SELECT name FROM sqlite_master WHERE type='table';" }],
                    dataSource,
                    config
                )
                const tables = tablesResult.map((row: any) => row.name)

                // 2. Kirim Header SQLite
                await writer.write(encoder.encode('SQLite format 3\0'))

                for (const table of tables) {
                    // 3. Ambil dan kirim Schema Tabel
                    const schemaResult = await executeOperation(
                        [{ sql: `SELECT sql FROM sqlite_master WHERE type='table' AND name='${table}';` }],
                        dataSource,
                        config
                    )

                    if (schemaResult.length) {
                        const schema = schemaResult[0].sql
                        await writer.write(encoder.encode(`\n-- Table: ${table}\n${schema};\n\n`))
                    }

                    // 4. Ambil Data Tabel (Streaming per baris)
                    const dataResult = await executeOperation(
                        [{ sql: `SELECT * FROM ${table};` }],
                        dataSource,
                        config
                    )

                    for (const row of dataResult) {
                        const values = Object.values(row).map((value) =>
                            typeof value === 'string'
                                ? `'${value.replace(/'/g, "''")}'`
                                : value
                        )
                        const line = `INSERT INTO ${table} VALUES (${values.join(', ')});\n`
                        await writer.write(encoder.encode(line))
                    }
                    await writer.write(encoder.encode('\n'))
                }
            } catch (err) {
                console.error("Streaming Error:", err)
            } finally {
                await writer.close()
            }
        })()

        // 5. Kembalikan Response berupa Stream (Gak pake Blob lagi!)
        return new Response(readable, {
            headers: {
                'Content-Type': 'application/x-sqlite3',
                'Content-Disposition': 'attachment; filename="database_dump.sql"',
                'Transfer-Encoding': 'chunked'
            }
        })
    } catch (error: any) {
        console.error('Database Dump Error:', error)
        return createResponse(undefined, 'Failed to create database dump', 500)
    }
}

