import {
    DEFAULT_EXPORT_BATCH_SIZE,
    DEFAULT_MAX_ACTIVE_WINDOW_MS,
    executeOperation,
} from '.'
import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { createResponse } from '../utils'

export interface R2BucketLike {
    put(
        key: string,
        value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob,
        options?: Record<string, any>
    ): Promise<any>
}

export interface DumpDatabaseOptions {
    batchSize?: number
    breathingIntervalMs?: number
    maxActiveWindowMs?: number
    r2Bucket?: R2BucketLike
    callbackUrl?: string
    now?: Date
}

export function formatDumpTimestamp(date: Date = new Date()): string {
    const pad = (n: number) => String(n).padStart(2, '0')
    const yyyy = date.getUTCFullYear()
    const mm = pad(date.getUTCMonth() + 1)
    const dd = pad(date.getUTCDate())
    const hh = pad(date.getUTCHours())
    const min = pad(date.getUTCMinutes())
    const ss = pad(date.getUTCSeconds())
    return `dump_${yyyy}${mm}${dd}-${hh}${min}${ss}.sql`
}

export function formatSqlLiteral(value: unknown): string {
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
    try {
        const batchSize = Math.max(
            1,
            options.batchSize ?? DEFAULT_EXPORT_BATCH_SIZE
        )
        const breathingIntervalMs = Math.max(
            0,
            options.breathingIntervalMs ?? 0
        )
        const maxActiveWindowMs = Math.max(
            1,
            options.maxActiveWindowMs ?? DEFAULT_MAX_ACTIVE_WINDOW_MS
        )

        // Get all table names
        const tablesResult = await executeOperation(
            [{ sql: "SELECT name FROM sqlite_master WHERE type='table';" }],
            dataSource,
            config
        )

        const tables = (tablesResult || []).map((row: any) => row.name)
        const encoder = new TextEncoder()
        const chunks: Uint8Array[] = [encoder.encode('SQLite format 3\0')]

        let windowStart = Date.now()
        let totalRowsExported = 0

        // Iterate through all tables using bounded pagination
        for (const table of tables) {
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
                chunks.push(
                    encoder.encode(`\n-- Table: ${table}\n${schema};\n\n`)
                )
            }

            let offset = 0
            while (true) {
                const sqlQuery =
                    offset === 0 && options.batchSize === undefined
                        ? `SELECT * FROM ${table};`
                        : `SELECT * FROM ${table} LIMIT ${batchSize} OFFSET ${offset};`

                const dataResult = await executeOperation(
                    [{ sql: sqlQuery }],
                    dataSource,
                    config
                )

                if (!Array.isArray(dataResult) || dataResult.length === 0) {
                    break
                }

                let batchSql = ''
                for (const row of dataResult) {
                    const values = Object.values(row).map(formatSqlLiteral)
                    batchSql += `INSERT INTO ${table} VALUES (${values.join(', ')});\n`
                    totalRowsExported++
                }
                chunks.push(encoder.encode(batchSql))

                if (dataResult.length < batchSize) {
                    break
                }

                offset += dataResult.length

                if (
                    breathingIntervalMs > 0 &&
                    Date.now() - windowStart >= maxActiveWindowMs
                ) {
                    await new Promise((resolve) =>
                        setTimeout(resolve, breathingIntervalMs)
                    )
                    windowStart = Date.now()
                }
            }

            chunks.push(encoder.encode('\n'))
        }

        const blob = new Blob(chunks, { type: 'application/x-sqlite3' })
        const r2Bucket =
            options.r2Bucket ||
            ((dataSource as any)?.r2Bucket as R2BucketLike | undefined) ||
            ((config as any)?.r2Bucket as R2BucketLike | undefined)

        const dumpFileName = formatDumpTimestamp(options.now)

        if (r2Bucket && typeof r2Bucket.put === 'function') {
            await r2Bucket.put(dumpFileName, blob, {
                httpMetadata: { contentType: 'application/x-sqlite3' },
            })
        }

        if (options.callbackUrl) {
            try {
                await fetch(options.callbackUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        status: 'completed',
                        fileName: dumpFileName,
                        tablesExported: tables.length,
                        rowsExported: totalRowsExported,
                        storedInR2: Boolean(r2Bucket),
                    }),
                })
            } catch (callbackErr) {
                console.error('Dump Callback Notification Error:', callbackErr)
            }
        }

        const headers = new Headers({
            'Content-Type': 'application/x-sqlite3',
            'Content-Disposition': 'attachment; filename="database_dump.sql"',
            'X-Dump-Filename': dumpFileName,
        })

        return new Response(blob, { headers })
    } catch (error: any) {
        console.error('Database Dump Error:', error)
        return createResponse(undefined, 'Failed to create database dump', 500)
    }
}
