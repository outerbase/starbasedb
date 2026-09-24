import { executeOperation } from './index'
import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { createResponse } from '../utils'
import {
    ChunkedDumpEngine,
    DEFAULT_DUMP_OPTIONS,
    normalizePartSizeBytes,
    quoteIdentifier,
    sqlCommentLabel,
    isSafeIdentifier,
    type DumpOptions,
} from './chunkedDump'

export const AUTO_JOB_THRESHOLD_BYTES = 8 * 1024 * 1024

export interface DumpJobEnv {
    R2_DUMP_BUCKET?: R2Bucket
}

export interface DumpEngineHost {
    storage: DurableObjectStorage
    env: DumpJobEnv
    dataSource: DataSource
    config: StarbaseDBConfiguration
    setAlarm: (
        time: number,
        options?: DurableObjectSetAlarmOptions
    ) => Promise<void>
}

export function parseDumpOptions(searchParams: URLSearchParams): DumpOptions {
    const options: DumpOptions = {}
    const readNumber = (key: string, target: keyof DumpOptions) => {
        const raw = searchParams.get(key)
        if (raw === null) return
        const value = Number(raw)
        if (Number.isFinite(value) && value > 0) {
            options[target] = value as never
        }
    }
    readNumber('cycleMs', 'cycleTimeBudgetMs')
    readNumber('breathMs', 'breathingIntervalMs')
    readNumber('rows', 'rowsPerBatch')
    readNumber('chunkBytes', 'chunkTargetBytes')
    const rawPartBytes = searchParams.get('partBytes')
    if (rawPartBytes !== null) {
        options.finalizePartSizeBytes = normalizePartSizeBytes(
            Number(rawPartBytes)
        )
    }
    readNumber('finalizeMs', 'finalizeTimeBudgetMs')
    return options
}

function legacyIdentifier(name: string): string {
    return isSafeIdentifier(name) ? name : quoteIdentifier(name)
}

function legacyValue(value: unknown): string {
    if (value === null || value === undefined) return 'NULL'
    if (typeof value === 'number')
        return Number.isFinite(value) ? String(value) : 'NULL'
    if (typeof value === 'bigint' || typeof value === 'boolean')
        return String(value)
    if (value instanceof ArrayBuffer) {
        return `X'${Array.from(new Uint8Array(value), (b) => b.toString(16).padStart(2, '0')).join('')}'`
    }
    if (ArrayBuffer.isView(value)) {
        return `X'${Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength), (b) => b.toString(16).padStart(2, '0')).join('')}'`
    }
    if (typeof value === 'string') return `'${value.replace(/'/g, "''")}'`
    return `'${(JSON.stringify(value) ?? String(value)).replace(/'/g, "''")}'`
}

export async function legacyDump(
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<Response> {
    try {
        const tablesResult = await executeOperation(
            [{ sql: "SELECT name FROM sqlite_master WHERE type='table';" }],
            dataSource,
            config
        )

        const tables = tablesResult
            .map((row: Record<string, unknown>) => String(row.name))
            .filter((name: string) => name.length > 0)
        let dumpContent = 'SQLite format 3\0'

        for (const table of tables) {
            const schemaResult = await executeOperation(
                [
                    {
                        sql: "SELECT sql FROM sqlite_master WHERE type='table' AND name=?;",
                        params: [table],
                    },
                ],
                dataSource,
                config
            )

            if (schemaResult.length && schemaResult[0]?.sql) {
                dumpContent += `\n-- Table: ${sqlCommentLabel(table)}\n${String(schemaResult[0].sql)};\n\n`
            }

            const dataResult = await executeOperation(
                [{ sql: `SELECT * FROM ${quoteIdentifier(table)};` }],
                dataSource,
                config
            )

            for (const row of dataResult) {
                const values = Object.values(row).map((value) =>
                    legacyValue(value)
                )
                dumpContent += `INSERT INTO ${legacyIdentifier(table)} VALUES (${values.join(', ')});\n`
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

export async function shouldUseResumableDump(
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<boolean> {
    try {
        const readPragma = async (sql: string): Promise<number> => {
            const result = await executeOperation([{ sql }], dataSource, config)
            const row = result[0] as Record<string, unknown> | undefined
            const value = row ? Object.values(row)[0] : undefined
            const number = Number(value)
            return Number.isFinite(number) ? number : 0
        }
        const pageCount = await readPragma('PRAGMA page_count;')
        const pageSize = await readPragma('PRAGMA page_size;')
        return pageCount * pageSize >= AUTO_JOB_THRESHOLD_BYTES
    } catch {
        return true
    }
}

export async function runDumpJob(
    host: DumpEngineHost,
    searchParams: URLSearchParams,
    requestStart: number = Date.now()
): Promise<Response> {
    try {
        const parsedOptions = parseDumpOptions(searchParams)
        const options = { ...DEFAULT_DUMP_OPTIONS, ...parsedOptions }
        const engine = new ChunkedDumpEngine(
            host.storage,
            host.env.R2_DUMP_BUCKET,
            host.dataSource,
            host.config,
            options
        )

        let state = await engine.getState()
        if (!state) {
            state = await engine.startDump()
        } else if (!state.completedAt) {
            state = await engine.runCycle()
        }

        while (
            !state.completedAt &&
            Date.now() - requestStart < options.cycleTimeBudgetMs
        ) {
            state = await engine.runCycle()
        }

        if (state.completedAt) {
            if (
                host.env.R2_DUMP_BUCKET &&
                (!state.finalizedAt || !state.temporaryChunksCleanedAt)
            ) {
                try {
                    await host.setAlarm(Date.now() + 1_000)
                } catch (alarmError) {
                    console.error(
                        'Failed to schedule dump finalize:',
                        alarmError
                    )
                }
            }
            const stream = await engine.assembleDump(state)
            if (stream) {
                return new Response(stream, {
                    headers: {
                        'Content-Type': 'application/x-sqlite3',
                        'Content-Disposition': `attachment; filename="${state.fileName}"`,
                    },
                })
            }
        }

        const resumeAt = Date.now() + options.breathingIntervalMs
        await host.setAlarm(resumeAt)
        return createResponse(
            {
                dumpId: state.dumpId,
                status: 'in-progress',
                phase: state.phase,
                progress: {
                    tablesTotal: state.tables.length,
                    tableIndex: state.tableIndex,
                    totalRows: state.totalRows,
                    bytesWritten: state.bytesWritten,
                    chunkIndex: state.chunkIndex,
                },
                resumeAt,
                fileName: state.fileName,
            },
            undefined,
            202
        )
    } catch (error: any) {
        console.error('Database Dump Error:', error)
        return createResponse(undefined, 'Failed to create database dump', 500)
    }
}

export async function dumpJobStatus(host: DumpEngineHost): Promise<Response> {
    const engine = new ChunkedDumpEngine(
        host.storage,
        host.env.R2_DUMP_BUCKET,
        host.dataSource,
        host.config,
        DEFAULT_DUMP_OPTIONS
    )
    const state = await engine.getState()
    if (!state) {
        return createResponse(undefined, 'No dump job found', 404)
    }
    if (!state.completedAt) {
        return createResponse(
            {
                dumpId: state.dumpId,
                status: 'in-progress',
                phase: state.phase,
                progress: {
                    tablesTotal: state.tables.length,
                    tableIndex: state.tableIndex,
                    totalRows: state.totalRows,
                    bytesWritten: state.bytesWritten,
                    chunkIndex: state.chunkIndex,
                },
                fileName: state.fileName,
            },
            undefined,
            202
        )
    }
    if (state.finalObjectKey) {
        const downloadUrl = await engine.getPresignedUrl()
        if (downloadUrl) {
            return createResponse(
                {
                    dumpId: state.dumpId,
                    status: 'complete',
                    downloadUrl,
                    downloadUrlExpiresInSeconds: 3600,
                    downloadType: 'presigned-url',
                    finalObjectKey: state.finalObjectKey,
                    size: state.finalObjectSize ?? state.bytesWritten,
                    totalRows: state.totalRows,
                    fileName: state.fileName,
                },
                undefined,
                200
            )
        }
    }
    const stream = await engine.assembleDump(state)
    if (!stream) {
        return createResponse(undefined, 'Dump data unavailable', 410)
    }
    return new Response(stream, {
        headers: {
            'Content-Type': 'application/x-sqlite3',
            'Content-Disposition': `attachment; filename="${state.fileName}"`,
        },
    })
}

export async function runDumpFinalize(host: DumpEngineHost): Promise<void> {
    const engine = new ChunkedDumpEngine(
        host.storage,
        host.env.R2_DUMP_BUCKET,
        host.dataSource,
        host.config,
        DEFAULT_DUMP_OPTIONS
    )
    const { done } = await engine.finalizeDump()
    if (!done) {
        await host.setAlarm(Date.now() + 1_000)
    }
}

export async function dumpDatabaseRoute(
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<Response> {
    return legacyDump(dataSource, config)
}
