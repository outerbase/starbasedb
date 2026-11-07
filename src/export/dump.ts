import { executeOperation } from '.'
import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { createResponse } from '../utils'

export interface DumpDatabaseOptions {
    batchSize?: number
    workIntervalMs?: number
    breathingIntervalMs?: number
}

const DEFAULT_BATCH_SIZE = 1000
const DEFAULT_WORK_INTERVAL_MS = 5000
const DEFAULT_BREATHING_INTERVAL_MS = 100

function formatSqlValue(value: unknown): string {
    if (value === null || value === undefined) {
        return 'NULL'
    }
    if (typeof value === 'string') {
        return `'${value.replace(/'/g, "''")}'`
    }
    if (typeof value === 'boolean') {
        return value ? '1' : '0'
    }
    return String(value)
}

export async function dumpDatabaseRoute(
    dataSource: DataSource,
    config: StarbaseDBConfiguration,
    options: DumpDatabaseOptions = {}
): Promise<Response> {
    const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
    const workIntervalMs = options.workIntervalMs ?? DEFAULT_WORK_INTERVAL_MS
    const breathingIntervalMs =
        options.breathingIntervalMs ?? DEFAULT_BREATHING_INTERVAL_MS

    try {
        // Get all user table names
        const tablesResult = await executeOperation(
            [{ sql: "SELECT name FROM sqlite_master WHERE type='table';" }],
            dataSource,
            config
        )

        const tables = (tablesResult || [])
            .map((row: any) => row.name)
            .filter(
                (name: unknown): name is string =>
                    typeof name === 'string' && !name.startsWith('sqlite_')
            )

        const encoder = new TextEncoder()
        const chunks: Uint8Array[] = [encoder.encode('SQLite format 3\0')]
        let activeStartTime = Date.now()

        const maybeBreathe = async () => {
            if (
                breathingIntervalMs > 0 &&
                Date.now() - activeStartTime >= workIntervalMs
            ) {
                await new Promise((resolve) =>
                    setTimeout(resolve, breathingIntervalMs)
                )
                activeStartTime = Date.now()
            }
        }

        // Iterate through all tables in paginated batches
        for (const table of tables) {
            await maybeBreathe()

            // Get table schema
            const escapedTable = table.replace(/'/g, "''")
            const schemaResult = await executeOperation(
                [
                    {
                        sql: `SELECT sql FROM sqlite_master WHERE type='table' AND name='${escapedTable}';`,
                    },
                ],
                dataSource,
                config
            )

            if (schemaResult && schemaResult.length) {
                const schema = schemaResult[0].sql
                chunks.push(encoder.encode(`\n-- Table: ${table}\n${schema};\n\n`))
            }

            // Paginate table data in batches to avoid loading large tables into memory at once
            let offset = 0
            while (true) {
                await maybeBreathe()

                const sql =
                    offset === 0 && options.batchSize === undefined
                        ? `SELECT * FROM ${table};`
                        : `SELECT * FROM ${table} LIMIT ${batchSize} OFFSET ${offset};`

                const dataResult =
                    (await executeOperation([{ sql }], dataSource, config)) ||
                    []

                if (dataResult.length > 0) {
                    let batchStatements = ''
                    for (const row of dataResult) {
                        const values = Object.values(row).map(formatSqlValue)
                        batchStatements += `INSERT INTO ${table} VALUES (${values.join(', ')});\n`
                    }
                    chunks.push(encoder.encode(batchStatements))
                }

                if (dataResult.length < batchSize) {
                    break
                }
                offset += batchSize
            }

            chunks.push(encoder.encode('\n'))
        }

        // Create a multi-part Blob from encoded chunks without allocating a single monolithic string
        const blob = new Blob(chunks, { type: 'application/x-sqlite3' })

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
