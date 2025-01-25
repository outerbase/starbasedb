import { executeOperation } from '.'
import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { createResponse } from '../utils'

interface DumpProgress {
    id: string
    status: 'in_progress' | 'completed' | 'failed'
    currentTable: string
    totalTables: number
    processedTables: number
    error?: string
    r2Key?: string
}

interface StoredDumpData {
    progress: DumpProgress
    tables: string[]
    currentTableIndex: number
    currentOffset: number
}

const CHUNK_SIZE = 1000 // Number of rows to process at a time
const PROCESSING_TIMEOUT = 5000 // 5 seconds of processing before taking a break
const BREATHING_INTERVAL = 5000 // 5 seconds break between processing chunks

export async function startChunkedDumpRoute(
    dataSource: DataSource,
    config: StarbaseDBConfiguration,
    env: any
): Promise<Response> {
    try {
        // Generate a unique ID for this dump operation
        const dumpId = crypto.randomUUID()
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
        const r2Key = `dump_${timestamp}.sql`

        // Initialize progress tracking
        const progress: DumpProgress = {
            id: dumpId,
            status: 'in_progress',
            currentTable: '',
            totalTables: 0,
            processedTables: 0,
            r2Key,
        }

        // Get all table names
        const tablesResult = await executeOperation(
            [{ sql: "SELECT name FROM sqlite_master WHERE type='table';" }],
            dataSource,
            config
        )

        const tables = tablesResult.map((row: any) => row.name)
        progress.totalTables = tables.length

        // Create initial file in R2 with SQLite header
        await env.DATABASE_DUMPS.put(r2Key, 'SQLite format 3\0\n', {
            httpMetadata: {
                contentType: 'application/x-sqlite3',
            },
        })

        // We use a DO alarm to continue processing after the initial request
        if (!dataSource.rpc.setAlarm || !dataSource.rpc.storage) {
            throw new Error(
                'setAlarm and storage capabilities required for chunked dumps'
            )
        }
        const alarm = await dataSource.rpc.setAlarm(Date.now() + 1000)

        // Store progress in DO storage for the alarm to pick up
        await dataSource.rpc.storage.put('dump_progress', {
            progress,
            tables,
            currentTableIndex: 0,
            currentOffset: 0,
        })

        return createResponse(
            {
                message: 'Database dump started',
                dumpId,
                status: 'in_progress',
                downloadUrl: `https://${env.WORKER_DOMAIN}/export/dump/${dumpId}`,
            },
            undefined,
            200
        )
    } catch (error: any) {
        console.error('Chunked Database Dump Error:', error)
        return createResponse(undefined, 'Failed to start database dump', 500)
    }
}

export async function processDumpChunk(
    dataSource: DataSource,
    config: StarbaseDBConfiguration,
    env: any
): Promise<void> {
    const stored = (await dataSource.rpc.storage.get(
        'dump_progress'
    )) as StoredDumpData
    if (!stored) return

    const { progress, tables, currentTableIndex, currentOffset } = stored
    const startTime = Date.now()

    try {
        const table = tables[currentTableIndex]
        progress.currentTable = table

        // Get table schema if this is the first chunk of the table
        if (currentOffset === 0) {
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
                const schemaContent = `\n-- Table: ${table}\n${schema};\n\n`

                // Append schema to R2 file
                const existingContent = await env.DATABASE_DUMPS.get(
                    progress.r2Key
                ).text()
                await env.DATABASE_DUMPS.put(
                    progress.r2Key,
                    existingContent + schemaContent
                )
            }
        }

        // Get chunk of data
        const dataResult = await executeOperation(
            [
                {
                    sql: `SELECT * FROM ${table} LIMIT ${CHUNK_SIZE} OFFSET ${currentOffset};`,
                },
            ],
            dataSource,
            config
        )

        // Process the chunk
        let insertStatements = ''
        for (const row of dataResult) {
            const values = Object.values(row).map((value) =>
                typeof value === 'string'
                    ? `'${value.replace(/'/g, "''")}'`
                    : value
            )
            insertStatements += `INSERT INTO ${table} VALUES (${values.join(', ')});\n`
        }

        // Append to R2 file
        if (insertStatements) {
            const existingContent = await env.DATABASE_DUMPS.get(
                progress.r2Key
            ).text()
            await env.DATABASE_DUMPS.put(
                progress.r2Key,
                existingContent + insertStatements
            )
        }

        // Update progress
        if (dataResult.length < CHUNK_SIZE) {
            // Move to next table
            progress.processedTables++
            if (currentTableIndex + 1 < tables.length) {
                await dataSource.rpc.storage.put('dump_progress', {
                    ...stored,
                    currentTableIndex: currentTableIndex + 1,
                    currentOffset: 0,
                })
            } else {
                // All done
                progress.status = 'completed'
                await dataSource.rpc.storage.delete('dump_progress')
            }
        } else {
            // Continue with next chunk of current table
            await dataSource.rpc.storage.put('dump_progress', {
                ...stored,
                currentOffset: currentOffset + CHUNK_SIZE,
            })
        }

        // Check if we need to take a break
        const elapsedTime = Date.now() - startTime
        if (
            elapsedTime >= PROCESSING_TIMEOUT &&
            progress.status !== 'completed'
        ) {
            // Schedule next chunk after breathing interval
            await dataSource.rpc.setAlarm(Date.now() + BREATHING_INTERVAL)
        } else if (progress.status !== 'completed') {
            // Continue immediately with next chunk
            await dataSource.rpc.setAlarm(Date.now() + 1000)
        }
    } catch (error: any) {
        console.error('Chunk Processing Error:', error)
        progress.status = 'failed'
        progress.error = error.message
        await dataSource.rpc.storage.delete('dump_progress')
    }
}

export async function getDumpStatusRoute(
    dumpId: string,
    dataSource: DataSource
): Promise<Response> {
    const stored = (await dataSource.rpc.storage.get(
        'dump_progress'
    )) as StoredDumpData
    if (!stored || stored.progress.id !== dumpId) {
        return createResponse(undefined, 'Dump not found', 404)
    }

    return createResponse(
        {
            status: stored.progress.status,
            progress: {
                currentTable: stored.progress.currentTable,
                processedTables: stored.progress.processedTables,
                totalTables: stored.progress.totalTables,
                error: stored.progress.error,
            },
        },
        undefined,
        200
    )
}

export async function getDumpFileRoute(
    dumpId: string,
    dataSource: DataSource,
    env: any
): Promise<Response> {
    const stored = (await dataSource.rpc.storage.get(
        'dump_progress'
    )) as StoredDumpData

    if (!stored || stored.progress.id !== dumpId) {
        return createResponse(undefined, 'Dump not found', 404)
    }

    if (stored.progress.status !== 'completed') {
        return createResponse(undefined, 'Dump is still in progress', 400)
    }

    const r2Object = await env.DATABASE_DUMPS.get(stored.progress.r2Key)
    if (!r2Object) {
        return createResponse(undefined, 'Dump file not found', 404)
    }

    const headers = new Headers({
        'Content-Type': 'application/x-sqlite3',
        'Content-Disposition': `attachment; filename="database_dump_${dumpId}.sql"`,
    })

    return new Response(r2Object.body, { headers })
}
