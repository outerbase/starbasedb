import { executeOperation } from '.'
import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { createResponse } from '../utils'

/**
 * Configuration constants for chunked export
 */
const BATCH_SIZE = 1000 // Rows per batch
const TIME_LIMIT_MS = 20_000 // 20 seconds before yielding (leaving buffer before 30s timeout)

/**
 * Represents the state of an ongoing export operation.
 * Stored in DO storage so export can be resumed after alarm.
 */
export interface ExportState {
    exportId: string
    status: 'pending' | 'processing' | 'completed' | 'failed'
    tables: string[]
    currentTableIndex: number
    currentRowOffset: number
    currentTableSchemaWritten: boolean
    r2Key: string
    callbackUrl?: string
    createdAt: number
    updatedAt: number
    error?: string
    totalRowsExported: number
}

/**
 * Generate a timestamped filename for the dump.
 * e.g. dump_20240101-170000.sql
 */
export function generateDumpFilename(): string {
    const now = new Date()
    const pad = (n: number) => n.toString().padStart(2, '0')
    const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    return `dump_${date}-${time}.sql`
}

/**
 * Generate a unique export ID.
 */
export function generateExportId(): string {
    return `export_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`
}

/**
 * Initialize a new export: get all table names, create initial R2 object,
 * and return the ExportState.
 */
export async function initializeExport(
    dataSource: DataSource,
    config: StarbaseDBConfiguration,
    r2Bucket: R2Bucket,
    callbackUrl?: string
): Promise<ExportState> {
    // Get all table names (excluding internal tmp_ tables)
    const tablesResult = await executeOperation(
        [
            {
                sql: "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'tmp_%';",
            },
        ],
        dataSource,
        config
    )

    const tables = tablesResult.map((row: any) => row.name)
    const exportId = generateExportId()
    const r2Key = generateDumpFilename()

    // Write the SQL header to R2
    const header =
        '-- StarbaseDB Database Dump\n-- Generated at: ' +
        new Date().toISOString() +
        '\n\n'
    await r2Bucket.put(r2Key, header)

    const state: ExportState = {
        exportId,
        status: 'processing',
        tables,
        currentTableIndex: 0,
        currentRowOffset: 0,
        currentTableSchemaWritten: false,
        r2Key,
        callbackUrl,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        totalRowsExported: 0,
    }

    return state
}

/**
 * Continue processing an export from its current state.
 * Processes rows in batches and appends SQL to the R2 object.
 * Returns the updated state — if status is still 'processing',
 * the caller should schedule an alarm to continue.
 */
export async function processExportChunk(
    state: ExportState,
    dataSource: DataSource,
    config: StarbaseDBConfiguration,
    r2Bucket: R2Bucket
): Promise<ExportState> {
    const startTime = Date.now()

    try {
        // Get existing content from R2 so we can append
        const existingObj = await r2Bucket.get(state.r2Key)
        let existingContent = existingObj ? await existingObj.text() : ''

        let newContent = ''

        while (state.currentTableIndex < state.tables.length) {
            const table = state.tables[state.currentTableIndex]

            // Write table schema if not yet written for this table
            if (!state.currentTableSchemaWritten) {
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

                if (schemaResult.length) {
                    const schema = schemaResult[0].sql
                    newContent += `\n-- Table: ${table}\n${schema};\n\n`
                }

                state.currentTableSchemaWritten = true
            }

            // Fetch rows in batches using LIMIT/OFFSET
            while (true) {
                // Check if we're approaching the time limit
                if (Date.now() - startTime > TIME_LIMIT_MS) {
                    // Save progress and yield
                    state.updatedAt = Date.now()
                    await r2Bucket.put(
                        state.r2Key,
                        existingContent + newContent
                    )
                    return state // Still 'processing' — caller should schedule alarm
                }

                const batchResult = await executeOperation(
                    [
                        {
                            sql: `SELECT * FROM "${table}" LIMIT ${BATCH_SIZE} OFFSET ${state.currentRowOffset};`,
                        },
                    ],
                    dataSource,
                    config
                )

                if (!batchResult.length) {
                    // No more rows in this table — move to next
                    break
                }

                for (const row of batchResult) {
                    const values = Object.values(row).map((value) =>
                        value === null
                            ? 'NULL'
                            : typeof value === 'string'
                              ? `'${value.replace(/'/g, "''")}'`
                              : value
                    )
                    newContent += `INSERT INTO "${table}" VALUES (${values.join(', ')});\n`
                }

                state.currentRowOffset += batchResult.length
                state.totalRowsExported += batchResult.length

                // If we got fewer rows than BATCH_SIZE, we've exhausted this table
                if (batchResult.length < BATCH_SIZE) {
                    break
                }
            }

            // Move to next table
            state.currentTableIndex++
            state.currentRowOffset = 0
            state.currentTableSchemaWritten = false
            newContent += '\n'
        }

        // All tables processed — export is complete
        state.status = 'completed'
        state.updatedAt = Date.now()
        await r2Bucket.put(state.r2Key, existingContent + newContent)

        // Fire callback if provided
        if (state.callbackUrl) {
            try {
                await fetch(state.callbackUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        exportId: state.exportId,
                        status: 'completed',
                        r2Key: state.r2Key,
                        totalRowsExported: state.totalRowsExported,
                        completedAt: new Date().toISOString(),
                    }),
                })
            } catch (callbackError) {
                console.error('Failed to send export callback:', callbackError)
            }
        }

        return state
    } catch (error: any) {
        state.status = 'failed'
        state.error = error?.message || 'Unknown export error'
        state.updatedAt = Date.now()

        // Try to notify via callback on failure too
        if (state.callbackUrl) {
            try {
                await fetch(state.callbackUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        exportId: state.exportId,
                        status: 'failed',
                        error: state.error,
                        failedAt: new Date().toISOString(),
                    }),
                })
            } catch (_) {
                // Best effort
            }
        }

        return state
    }
}

/**
 * Synchronous fast-path: For small databases that complete within the time limit,
 * return the dump directly in the response. Falls back to async R2 export
 * if the operation would exceed the time limit.
 */
export async function dumpDatabaseChunkedRoute(
    dataSource: DataSource,
    config: StarbaseDBConfiguration,
    r2Bucket: R2Bucket | undefined,
    request: Request,
    scheduleAlarm: (exportState: ExportState) => Promise<void>,
    getExportState: () => Promise<ExportState | null>,
    saveExportState: (state: ExportState) => Promise<void>
): Promise<Response> {
    try {
        let callbackUrl: string | undefined

        // Parse callbackUrl from query params or body
        const url = new URL(request.url)
        callbackUrl = url.searchParams.get('callbackUrl') ?? undefined

        // If R2 is not configured, fall back to the legacy in-memory dump
        if (!r2Bucket) {
            // Import and delegate to the original dump function
            const { dumpDatabaseRoute } = await import('./dump')
            return dumpDatabaseRoute(dataSource, config)
        }

        // Initialize the export
        const state = await initializeExport(
            dataSource,
            config,
            r2Bucket,
            callbackUrl
        )
        await saveExportState(state)

        // Start processing
        const updatedState = await processExportChunk(
            state,
            dataSource,
            config,
            r2Bucket
        )
        await saveExportState(updatedState)

        if (updatedState.status === 'completed') {
            // Fast path: export completed within time limit — return the file directly
            const r2Object = await r2Bucket.get(updatedState.r2Key)

            if (!r2Object) {
                return createResponse(
                    undefined,
                    'Export file not found in R2',
                    500
                )
            }

            const content = await r2Object.text()
            const headers = new Headers({
                'Content-Type': 'application/sql',
                'Content-Disposition': `attachment; filename="${updatedState.r2Key}"`,
            })

            return new Response(content, { headers })
        }

        // Async path: export still processing — schedule alarm to continue
        await scheduleAlarm(updatedState)

        return createResponse(
            {
                exportId: updatedState.exportId,
                status: updatedState.status,
                message:
                    'Export is in progress. It will continue in the background.',
                r2Key: updatedState.r2Key,
                totalRowsExported: updatedState.totalRowsExported,
            },
            undefined,
            202
        )
    } catch (error: any) {
        console.error('Chunked Database Dump Error:', error)
        return createResponse(
            undefined,
            'Failed to create database dump: ' +
                (error?.message || 'Unknown error'),
            500
        )
    }
}

/**
 * GET /export/status/:exportId — Check the status of an async export.
 */
export async function exportStatusRoute(
    exportId: string,
    getExportState: (id: string) => Promise<ExportState | null>
): Promise<Response> {
    try {
        const state = await getExportState(exportId)

        if (!state) {
            return createResponse(undefined, 'Export not found', 404)
        }

        return createResponse(
            {
                exportId: state.exportId,
                status: state.status,
                r2Key: state.r2Key,
                totalRowsExported: state.totalRowsExported,
                tablesTotal: state.tables.length,
                tablesProcessed: state.currentTableIndex,
                createdAt: new Date(state.createdAt).toISOString(),
                updatedAt: new Date(state.updatedAt).toISOString(),
                error: state.error,
            },
            undefined,
            200
        )
    } catch (error: any) {
        return createResponse(undefined, 'Failed to get export status', 500)
    }
}

/**
 * GET /export/download/:exportId — Download a completed export from R2.
 */
export async function exportDownloadRoute(
    exportId: string,
    r2Bucket: R2Bucket,
    getExportState: (id: string) => Promise<ExportState | null>
): Promise<Response> {
    try {
        const state = await getExportState(exportId)

        if (!state) {
            return createResponse(undefined, 'Export not found', 404)
        }

        if (state.status !== 'completed') {
            return createResponse(
                {
                    exportId: state.exportId,
                    status: state.status,
                    message:
                        state.status === 'processing'
                            ? 'Export is still in progress. Please try again later.'
                            : `Export failed: ${state.error}`,
                },
                state.status === 'failed' ? state.error : undefined,
                state.status === 'processing' ? 202 : 500
            )
        }

        const r2Object = await r2Bucket.get(state.r2Key)

        if (!r2Object) {
            return createResponse(
                undefined,
                'Export file not found in storage',
                404
            )
        }

        const headers = new Headers({
            'Content-Type': 'application/sql',
            'Content-Disposition': `attachment; filename="${state.r2Key}"`,
            'Content-Length': r2Object.size.toString(),
        })

        return new Response(r2Object.body, { headers })
    } catch (error: any) {
        return createResponse(undefined, 'Failed to download export', 500)
    }
}
