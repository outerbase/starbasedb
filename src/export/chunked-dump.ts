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
    callbackUrl?: string
    estimatedSize?: number
}

interface StoredDumpData {
    progress: DumpProgress
    tables: string[]
    currentTableIndex: number
    currentOffset: number
    useR2: boolean
    chunkSize: number
}

const DEFAULT_CHUNK_SIZE = 1000 // Default number of rows to process at a time
const LARGE_CHUNK_SIZE = 5000 // Chunk size for small tables
const SMALL_CHUNK_SIZE = 500 // Chunk size for large tables
const SIZE_THRESHOLD_FOR_R2 = 100 * 1024 * 1024 // 100MB threshold for using R2
const PROCESSING_TIMEOUT = 5000 // 5 seconds of processing before taking a break
const BREATHING_INTERVAL = 5000 // 5 seconds break between processing chunks

async function estimateDatabaseSize(
    dataSource: DataSource,
    tables: string[]
): Promise<number> {
    let totalSize = 0
    for (const table of tables) {
        const quotedTable = `"${table.replace(/"/g, '""')}"` // Properly escape quotes in table names

        // Get row count
        const countResult = (await dataSource.rpc.executeQuery({
            sql: `SELECT COUNT(*) as count FROM ${quotedTable};`,
        })) as Record<string, number>[]
        const rowCount = countResult[0]?.count || 0

        // Get table schema to understand column types
        const schemaResult = (await dataSource.rpc.executeQuery({
            sql: `SELECT sql FROM sqlite_master WHERE type='table' AND name=?;`,
            params: [table],
        })) as Record<string, string>[]

        // Sample some rows to get average row size
        const sampleSize = Math.min(100, rowCount) // Sample up to 100 rows
        if (sampleSize > 0) {
            const sampleResult = (await dataSource.rpc.executeQuery({
                sql: `SELECT * FROM ${quotedTable} LIMIT ?;`,
                params: [sampleSize],
            })) as Record<string, unknown>[]

            // Calculate average row size from sample
            if (sampleResult.length > 0) {
                const totalSampleSize = sampleResult.reduce((size, row) => {
                    // Convert row to SQL insert statement to estimate actual dump size
                    const values = Object.values(row).map((value) =>
                        typeof value === 'string'
                            ? `'${value.replace(/'/g, "''")}'`
                            : value === null
                              ? 'NULL'
                              : String(value)
                    )
                    const insertStmt = `INSERT INTO ${table} VALUES (${values.join(', ')});\n`
                    return size + insertStmt.length
                }, 0)

                const avgRowSize = Math.ceil(
                    totalSampleSize / sampleResult.length
                )
                totalSize += rowCount * avgRowSize
            }
        }

        // Add size for table schema
        if (schemaResult[0]?.sql) {
            totalSize += schemaResult[0].sql.length + 20 // Add some padding for formatting
        }
    }

    // Add some overhead for SQLite header and formatting
    totalSize += 100 // SQLite header
    totalSize = Math.ceil(totalSize * 1.1) // Add 10% overhead for safety

    return totalSize
}

function determineChunkSize(tableRowCount: number): number {
    if (tableRowCount < 10000) {
        return LARGE_CHUNK_SIZE // Larger chunks for small tables
    } else if (tableRowCount > 100000) {
        return SMALL_CHUNK_SIZE // Smaller chunks for large tables
    }
    return DEFAULT_CHUNK_SIZE
}

async function notifyCallback(
    callbackUrl: string,
    dumpId: string,
    status: string
) {
    try {
        await fetch(callbackUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                dumpId,
                status,
                timestamp: new Date().toISOString(),
            }),
        })
    } catch (error) {
        console.error('Error notifying callback:', error)
    }
}

export async function startChunkedDumpRoute(
    dataSource: DataSource,
    config: StarbaseDBConfiguration,
    env: any,
    request?: Request
): Promise<Response> {
    try {
        // Generate a unique ID for this dump operation
        const dumpId = crypto.randomUUID()
        const now = new Date()
        const timestamp =
            now.getUTCFullYear().toString() +
            String(now.getUTCMonth() + 1).padStart(2, '0') +
            String(now.getUTCDate()).padStart(2, '0') +
            '-' +
            String(now.getUTCHours()).padStart(2, '0') +
            String(now.getUTCMinutes()).padStart(2, '0') +
            String(now.getUTCSeconds()).padStart(2, '0')
        const r2Key = `dump_${timestamp}.sql`

        // Get callback URL from request if provided
        const callbackUrl = request?.headers.get('X-Callback-URL') || undefined

        // Initialize progress tracking
        const progress: DumpProgress = {
            id: dumpId,
            status: 'in_progress',
            currentTable: '',
            totalTables: 0,
            processedTables: 0,
            r2Key,
            callbackUrl,
        }

        // Get all table names
        const tablesResult = await executeOperation(
            [
                {
                    sql: "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%';",
                },
            ],
            dataSource,
            config
        )

        const tables = tablesResult.map((row: any) => row.name)
        progress.totalTables = tables.length

        // Estimate database size
        const estimatedSize = await estimateDatabaseSize(dataSource, tables)
        progress.estimatedSize = estimatedSize
        console.log('Estimated database size:', estimatedSize, 'bytes')

        // Determine storage type based on size
        const shouldUseR2 = Boolean(
            env?.DATABASE_DUMPS && estimatedSize > SIZE_THRESHOLD_FOR_R2
        )
        if (shouldUseR2) {
            if (!env?.DATABASE_DUMPS) {
                throw new Error(
                    'R2 storage requested but R2 binding not available'
                )
            }
            // Test R2 access
            try {
                await env.DATABASE_DUMPS.head(r2Key)
            } catch (error) {
                console.error('R2 access test failed:', error)
                throw new Error(
                    'R2 storage is not accessible. Please check your R2 bucket configuration.'
                )
            }
        }

        // Store initial content
        if (shouldUseR2) {
            await env.DATABASE_DUMPS.put(r2Key, 'SQLite format 3\0\n', {
                httpMetadata: {
                    contentType: 'application/x-sqlite3',
                },
            })
        } else {
            await dataSource.rpc.storage.put(r2Key, 'SQLite format 3\0\n')
        }

        // We use a DO alarm to continue processing after the initial request
        if (!dataSource.rpc.setAlarm || !dataSource.rpc.storage) {
            throw new Error(
                'setAlarm and storage capabilities required for chunked dumps'
            )
        }
        const alarm = await dataSource.rpc.setAlarm(Date.now() + 1000)

        // Store progress in DO storage for the alarm to pick up
        const progressKey = `dump_progress_${dumpId}`
        await dataSource.rpc.storage.put(progressKey, {
            progress,
            tables,
            currentTableIndex: 0,
            currentOffset: 0,
            useR2: shouldUseR2,
            chunkSize: DEFAULT_CHUNK_SIZE,
        })

        // Get base URL from request or fallback to localhost
        const baseUrl = request
            ? new URL(request.url).origin
            : 'http://localhost:8787'

        return createResponse(
            {
                message: 'Database dump started',
                dumpId,
                status: 'in_progress',
                downloadUrl: `${baseUrl}/export/dump/${dumpId}`,
                estimatedSize,
            },
            undefined,
            200
        )
    } catch (error: any) {
        console.error('Chunked Database Dump Error:', error)
        console.error('Error stack:', error.stack)
        console.error('Error details:', {
            message: error.message,
            name: error.name,
            cause: error.cause,
        })
        return createResponse(
            undefined,
            `Failed to start database dump: ${error.message}`,
            500
        )
    }
}

export async function processDumpChunk(
    dataSource: DataSource,
    config: StarbaseDBConfiguration,
    env: any
): Promise<void> {
    try {
        console.log('Starting processDumpChunk')
        // Get all dump progress keys
        const allKeys = await dataSource.rpc.storage.list({
            prefix: 'dump_progress_',
        })
        console.log('Found dump progress keys:', allKeys)

        let hasActiveDumps = false

        // Process each active dump
        for (const progressKey of allKeys.keys()) {
            const stored = (await dataSource.rpc.storage.get(
                progressKey
            )) as StoredDumpData & { useR2: boolean }

            if (
                !stored ||
                stored.progress.status === 'completed' ||
                stored.progress.status === 'failed'
            ) {
                // Clean up completed or failed dumps that weren't properly cleaned
                await dataSource.rpc.storage.delete(progressKey)
                continue
            }

            hasActiveDumps = true
            console.log('Processing dump with key:', progressKey)
            const {
                progress,
                tables,
                currentTableIndex,
                currentOffset,
                useR2,
                chunkSize,
            } = stored
            console.log('Processing table:', {
                currentTable: tables[currentTableIndex],
                currentTableIndex,
                totalTables: tables.length,
                currentOffset,
            })

            const startTime = Date.now()

            try {
                const table = tables[currentTableIndex]
                progress.currentTable = table

                // Get table schema if this is the first chunk of the table
                if (currentOffset === 0) {
                    console.log('Getting schema for table:', table)
                    const schemaResult = (await dataSource.rpc.executeQuery({
                        sql: `SELECT sql FROM sqlite_master WHERE type='table' AND name=?;`,
                        params: [table],
                    })) as Record<string, string>[]
                    console.log('Schema result:', schemaResult)

                    if (schemaResult && schemaResult[0]?.sql) {
                        const schema = schemaResult[0]?.sql
                        const schemaContent = `\n-- Table: ${table}\n${schema};\n\n`

                        // Append schema to file
                        if (useR2 && progress.r2Key) {
                            const r2Object = await env.DATABASE_DUMPS.get(
                                progress.r2Key
                            )
                            if (!r2Object) {
                                const existingContent = ''
                                await env.DATABASE_DUMPS.put(
                                    progress.r2Key,
                                    existingContent + schemaContent,
                                    {
                                        httpMetadata: {
                                            contentType: 'application/sql',
                                        },
                                    }
                                )
                            } else {
                                const existingContent = await r2Object
                                    .arrayBuffer()
                                    .then((buf: ArrayBuffer) =>
                                        new TextDecoder().decode(buf)
                                    )
                                await env.DATABASE_DUMPS.put(
                                    progress.r2Key,
                                    existingContent + schemaContent,
                                    {
                                        httpMetadata: {
                                            contentType: 'application/sql',
                                        },
                                    }
                                )
                            }
                        } else if (progress.r2Key) {
                            const existingContent =
                                ((await dataSource.rpc.storage.get(
                                    progress.r2Key
                                )) as string) || ''
                            await dataSource.rpc.storage.put(
                                progress.r2Key,
                                existingContent + schemaContent
                            )
                        }

                        // Determine chunk size based on table size
                        const rows = (await dataSource.rpc.executeQuery({
                            sql: `SELECT * FROM "${table.replace(/"/g, '""')}";`,
                        })) as Record<string, unknown>[]
                        if (rows && rows.length > 0) {
                            const rowCount = rows.length as number
                            stored.chunkSize = determineChunkSize(rowCount)
                            console.log(
                                `Adjusted chunk size for table ${table}:`,
                                stored.chunkSize
                            )
                        }
                    }
                }

                // Get chunk of data
                console.log('Getting data chunk for table:', table)
                const dataResult = (await dataSource.rpc.executeQuery({
                    sql: `SELECT * FROM "${table.replace(/"/g, '""')}" LIMIT ? OFFSET ?;`,
                    params: [stored.chunkSize, currentOffset],
                })) as Record<string, unknown>[]
                console.log('Data result:', dataResult)

                // Process the chunk
                let insertStatements = ''
                if (Array.isArray(dataResult)) {
                    for (const row of dataResult) {
                        const values = Object.values(row).map((value) =>
                            typeof value === 'string'
                                ? `'${value.replace(/'/g, "''")}'`
                                : value === null
                                  ? 'NULL'
                                  : value
                        )
                        insertStatements += `INSERT INTO ${table} VALUES (${values.join(', ')});\n`
                    }
                } else {
                    console.warn(
                        'Data result is not an array:',
                        typeof dataResult
                    )
                }

                // Append to file
                if (insertStatements && progress.r2Key) {
                    console.log('Appending insert statements to file')
                    if (useR2) {
                        const r2Object = await env.DATABASE_DUMPS.get(
                            progress.r2Key
                        )
                        if (!r2Object) {
                            const existingContent = ''
                            await env.DATABASE_DUMPS.put(
                                progress.r2Key,
                                existingContent + insertStatements,
                                {
                                    httpMetadata: {
                                        contentType: 'application/sql',
                                    },
                                }
                            )
                        } else {
                            const existingContent = await r2Object
                                .arrayBuffer()
                                .then((buf: ArrayBuffer) =>
                                    new TextDecoder().decode(buf)
                                )
                            await env.DATABASE_DUMPS.put(
                                progress.r2Key,
                                existingContent + insertStatements,
                                {
                                    httpMetadata: {
                                        contentType: 'application/sql',
                                    },
                                }
                            )
                        }
                    } else {
                        const existingContent =
                            ((await dataSource.rpc.storage.get(
                                progress.r2Key
                            )) as string) || ''
                        await dataSource.rpc.storage.put(
                            progress.r2Key,
                            existingContent + insertStatements
                        )
                    }
                }

                // Update progress
                if (
                    !Array.isArray(dataResult) ||
                    dataResult.length < stored.chunkSize
                ) {
                    // Move to next table
                    console.log('Moving to next table')
                    progress.processedTables++
                    if (currentTableIndex + 1 < tables.length) {
                        await dataSource.rpc.storage.put(progressKey, {
                            ...stored,
                            progress,
                            currentTableIndex: currentTableIndex + 1,
                            currentOffset: 0,
                        })
                    } else {
                        // All done
                        console.log('Dump completed')
                        progress.status = 'completed'
                        // Update progress instead of deleting it
                        await dataSource.rpc.storage.put(progressKey, {
                            ...stored,
                            progress,
                        })

                        // Send callback if configured
                        if (progress.callbackUrl) {
                            await notifyCallback(
                                progress.callbackUrl,
                                progress.id,
                                'completed'
                            )
                        }
                        continue // Move to next dump if any
                    }
                } else {
                    // Continue with next chunk of current table
                    console.log('Moving to next chunk')
                    await dataSource.rpc.storage.put(progressKey, {
                        ...stored,
                        progress,
                        currentOffset: currentOffset + stored.chunkSize,
                    })
                }

                // Check if we need to take a break
                if (Date.now() - startTime >= PROCESSING_TIMEOUT) {
                    console.log('Taking a break from processing')
                    await dataSource.rpc.setAlarm(
                        Date.now() + BREATHING_INTERVAL
                    )
                    return
                }
            } catch (error: any) {
                console.error('Error processing chunk:', error)
                progress.status = 'failed'
                progress.error = error.message
                await dataSource.rpc.storage.put(progressKey, {
                    ...stored,
                    progress,
                })

                // Send callback if configured
                if (progress.callbackUrl) {
                    await notifyCallback(
                        progress.callbackUrl,
                        progress.id,
                        'failed'
                    )
                }
            }
        }

        // Only schedule next processing if there are active dumps in progress
        if (hasActiveDumps) {
            await dataSource.rpc.setAlarm(Date.now() + BREATHING_INTERVAL)
        }
    } catch (error: any) {
        console.error('Error in processDumpChunk:', error)
        console.error('Error stack:', error.stack)
    }
}

export async function getDumpStatusRoute(
    dumpId: string,
    dataSource: DataSource
): Promise<Response> {
    try {
        console.log('Checking dump status for ID:', dumpId)
        const progressKey = `dump_progress_${dumpId}`
        const stored = (await dataSource.rpc.storage.get(
            progressKey
        )) as StoredDumpData & { useR2: boolean }
        console.log('Stored dump progress:', stored)

        if (!stored) {
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
    } catch (error: any) {
        console.error('Error checking dump status:', error)
        console.error('Error stack:', error.stack)
        return createResponse(
            undefined,
            `Error checking dump status: ${error.message}`,
            500
        )
    }
}

export async function getDumpFileRoute(
    dumpId: string,
    dataSource: DataSource,
    env: any
): Promise<Response> {
    try {
        console.log('Getting dump file for ID:', dumpId)
        const progressKey = `dump_progress_${dumpId}`
        const stored = (await dataSource.rpc.storage.get(
            progressKey
        )) as StoredDumpData & { useR2: boolean }
        console.log('Stored dump progress:', stored)

        if (!stored) {
            return createResponse(undefined, 'Dump not found', 404)
        }

        if (stored.progress.status !== 'completed') {
            return createResponse(undefined, 'Dump is still in progress', 400)
        }

        if (!stored.progress.r2Key) {
            return createResponse(undefined, 'Dump file key not found', 404)
        }

        let content: string | ReadableStream
        let headers = new Headers({
            'Content-Type': 'application/sql',
            'Content-Disposition': `attachment; filename="database_dump_${dumpId}.sql"`,
        })

        try {
            if (stored.useR2) {
                const r2Object = await env.DATABASE_DUMPS.get(
                    stored.progress.r2Key
                )
                if (!r2Object) {
                    return createResponse(
                        undefined,
                        'Dump file not found in R2',
                        404
                    )
                }
                content = r2Object.body
            } else {
                content =
                    ((await dataSource.rpc.storage.get(
                        stored.progress.r2Key
                    )) as string) || ''
                if (!content) {
                    return createResponse(
                        undefined,
                        'Dump file not found in storage',
                        404
                    )
                }
            }

            // Create response before cleanup
            const response = new Response(content, { headers })

            // Clean up after successful retrieval
            try {
                // Delete progress data
                await dataSource.rpc.storage.delete(progressKey)

                // Delete the dump file if using DO storage
                if (!stored.useR2) {
                    await dataSource.rpc.storage.delete(stored.progress.r2Key)
                }

                // Delete from R2 if using R2 storage
                if (stored.useR2 && env?.DATABASE_DUMPS) {
                    await env.DATABASE_DUMPS.delete(stored.progress.r2Key)
                }
            } catch (cleanupError) {
                console.error('Error during cleanup:', cleanupError)
                // Continue with response even if cleanup fails
            }

            return response
        } catch (error) {
            console.error('Error retrieving dump file:', error)
            return createResponse(undefined, 'Error retrieving dump file', 500)
        }
    } catch (error: any) {
        console.error('Error getting dump file:', error)
        console.error('Error stack:', error.stack)
        return createResponse(
            undefined,
            `Error getting dump file: ${error.message}`,
            500
        )
    }
}
