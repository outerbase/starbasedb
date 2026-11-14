import { executeOperation } from '.'
import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { createResponse } from '../utils'

export interface DumpDatabaseOptions {
    chunkSize?: number
    breathingIntervalMs?: number
    maxExecutionMs?: number
    callbackUrl?: string
    useR2?: boolean
    now?: Date
    resumeState?: DumpJobState
    onPauseForAlarm?: (state: DumpJobState) => Promise<void>
}

export interface DumpJobState {
    fileName: string
    tables: string[]
    tableIndex: number
    rowOffset: number
    schemaWrittenForCurrentTable: boolean
    accumulatedSql: string
    chunkSize: number
    breathingIntervalMs: number
    maxExecutionMs: number
    callbackUrl?: string
}

/**
 * Formats a timestamped SQL dump filename as `dump_YYYYMMDD-HHMMSS.sql`.
 */
export function formatDumpFilename(date: Date = new Date()): string {
    const pad = (n: number) => String(n).padStart(2, '0')
    const yyyy = date.getUTCFullYear()
    const mm = pad(date.getUTCMonth() + 1)
    const dd = pad(date.getUTCDate())
    const hh = pad(date.getUTCHours())
    const min = pad(date.getUTCMinutes())
    const ss = pad(date.getUTCSeconds())
    return `dump_${yyyy}${mm}${dd}-${hh}${min}${ss}.sql`
}

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

async function parseRequestOptions(
    request?: Request,
    explicitOptions?: DumpDatabaseOptions
): Promise<DumpDatabaseOptions> {
    const merged: DumpDatabaseOptions = { ...explicitOptions }
    if (!request) {
        return merged
    }

    try {
        const url = new URL(request.url)
        const chunkParam = url.searchParams.get('chunkSize')
        if (chunkParam && merged.chunkSize === undefined) {
            const parsed = Number(chunkParam)
            if (Number.isFinite(parsed) && parsed > 0) {
                merged.chunkSize = parsed
            }
        }
        const cbParam = url.searchParams.get('callbackUrl')
        if (cbParam && !merged.callbackUrl) {
            merged.callbackUrl = cbParam
        }
        const r2Param = url.searchParams.get('r2')
        if (r2Param === 'true' || r2Param === '1') {
            merged.useR2 = true
        }

        if (request.method === 'POST') {
            const body: any = await request.clone().json().catch(() => null)
            if (body && typeof body === 'object') {
                if (typeof body.chunkSize === 'number' && body.chunkSize > 0) {
                    merged.chunkSize = body.chunkSize
                }
                if (typeof body.breathingIntervalMs === 'number') {
                    merged.breathingIntervalMs = body.breathingIntervalMs
                }
                if (typeof body.maxExecutionMs === 'number') {
                    merged.maxExecutionMs = body.maxExecutionMs
                }
                if (typeof body.callbackUrl === 'string') {
                    merged.callbackUrl = body.callbackUrl
                }
                if (typeof body.useR2 === 'boolean') {
                    merged.useR2 = body.useR2
                }
            }
        }
    } catch {
        // Ignore URL/body parsing errors and fall back to defaults
    }

    return merged
}

export async function dumpDatabaseRoute(
    dataSource: DataSource,
    config: StarbaseDBConfiguration,
    request?: Request,
    options?: DumpDatabaseOptions
): Promise<Response> {
    try {
        const opts = await parseRequestOptions(request, options)
        const chunkSize = opts.chunkSize ?? 500
        const breathingIntervalMs = opts.breathingIntervalMs ?? 0
        const maxExecutionMs = opts.maxExecutionMs ?? 20000
        const startTime = Date.now()

        let state: DumpJobState

        if (opts.resumeState) {
            state = { ...opts.resumeState }
        } else {
            // Get all table names (excluding internal temporary/dump tables if any)
            const tablesResult = await executeOperation(
                [{ sql: "SELECT name FROM sqlite_master WHERE type='table';" }],
                dataSource,
                config
            )

            const tables = tablesResult.map((row: any) => row.name)
            state = {
                fileName: formatDumpFilename(opts.now),
                tables,
                tableIndex: 0,
                rowOffset: 0,
                schemaWrittenForCurrentTable: false,
                accumulatedSql: 'SQLite format 3\0',
                chunkSize,
                breathingIntervalMs,
                maxExecutionMs,
                callbackUrl: opts.callbackUrl,
            }
        }

        // Iterate through tables starting from state.tableIndex
        while (state.tableIndex < state.tables.length) {
            const table = state.tables[state.tableIndex]

            if (!state.schemaWrittenForCurrentTable) {
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
                    state.accumulatedSql += `\n-- Table: ${table}\n${schema};\n\n`
                }
                state.schemaWrittenForCurrentTable = true
            }

            // Paginate table data in chunks to avoid loading huge tables in a single query
            let hasMoreRows = true
            while (hasMoreRows) {
                const sql =
                    state.rowOffset === 0 && opts.chunkSize === undefined
                        ? `SELECT * FROM ${table};`
                        : `SELECT * FROM ${table} LIMIT ${state.chunkSize} OFFSET ${state.rowOffset};`

                const dataResult = await executeOperation(
                    [{ sql }],
                    dataSource,
                    config
                )

                for (const row of dataResult) {
                    const values = Object.values(row).map(formatSqlValue)
                    state.accumulatedSql += `INSERT INTO ${table} VALUES (${values.join(', ')});\n`
                }

                if (dataResult.length < state.chunkSize) {
                    hasMoreRows = false
                } else {
                    state.rowOffset += dataResult.length

                    if (state.breathingIntervalMs > 0) {
                        await new Promise((resolve) =>
                            setTimeout(resolve, state.breathingIntervalMs)
                        )
                    }

                    // Check if we are approaching the 30-second Durable Object execution limit
                    if (Date.now() - startTime >= state.maxExecutionMs) {
                        if (dataSource.r2Bucket) {
                            await dataSource.r2Bucket.put(
                                state.fileName,
                                state.accumulatedSql,
                                {
                                    httpMetadata: {
                                        contentType: 'application/sql',
                                    },
                                }
                            )
                        }

                        if (opts.onPauseForAlarm) {
                            await opts.onPauseForAlarm(state)
                        } else if (dataSource.rpc?.setAlarm) {
                            await dataSource.rpc.setAlarm(Date.now() + 1000)
                        }

                        return createResponse(
                            {
                                status: 'in_progress',
                                fileName: state.fileName,
                                tableIndex: state.tableIndex,
                                rowOffset: state.rowOffset,
                            },
                            undefined,
                            202
                        )
                    }
                }
            }

            state.accumulatedSql += '\n'
            state.tableIndex += 1
            state.rowOffset = 0
            state.schemaWrittenForCurrentTable = false
        }

        const shouldUploadToR2 = Boolean(
            dataSource.r2Bucket && (opts.useR2 || opts.callbackUrl || opts.resumeState)
        )

        if (shouldUploadToR2 && dataSource.r2Bucket) {
            await dataSource.r2Bucket.put(state.fileName, state.accumulatedSql, {
                httpMetadata: { contentType: 'application/sql' },
            })

            if (state.callbackUrl) {
                await fetch(state.callbackUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        status: 'completed',
                        fileName: state.fileName,
                        tablesExported: state.tables.length,
                        bytesWritten: state.accumulatedSql.length,
                    }),
                })
            }

            return createResponse(
                {
                    status: 'completed',
                    fileName: state.fileName,
                    tablesExported: state.tables.length,
                    bytesWritten: state.accumulatedSql.length,
                },
                undefined,
                200
            )
        }

        // Create a Blob from the dump content for direct download
        const blob = new Blob([state.accumulatedSql], {
            type: 'application/x-sqlite3',
        })

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
