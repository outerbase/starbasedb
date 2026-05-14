import { executeOperation } from '.'
import { StarbaseDBConfiguration } from '../handler'
import { DataSource } from '../types'
import { createResponse } from '../utils'

const DEFAULT_EXPORT_CHUNK_SIZE = 500
const DEFAULT_ASYNC_TIME_BUDGET_MS = 20_000

type AsyncDumpManifest = {
    status: 'running' | 'completed' | 'failed'
    filename: string
    callbackUrl?: string
    chunkSize: number
    tableIndex: number
    offset: number
    part: number
    tables?: string[]
    error?: string
    createdAt: string
    updatedAt: string
}

function quoteIdentifier(identifier: string): string {
    return `"${identifier.replace(/"/g, '""')}"`
}

function sqlValue(value: unknown): string {
    if (value === null || value === undefined) return 'NULL'
    if (typeof value === 'number' || typeof value === 'bigint') return String(value)
    if (typeof value === 'boolean') return value ? '1' : '0'
    if (value instanceof ArrayBuffer) {
        return `X'${Array.from(new Uint8Array(value)).map((b) => b.toString(16).padStart(2, '0')).join('')}'`
    }
    return `'${String(value).replace(/'/g, "''")}'`
}

function dumpFilename() {
    return `dump_${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z').replace('T', '-')}.sql`
}

function manifestKey(filename: string) {
    return `${filename}.manifest.json`
}

function partKey(filename: string, part: number) {
    return `${filename}.parts/${String(part).padStart(8, '0')}.sql`
}

async function notifyCallback(url: string | undefined, payload: Record<string, unknown>) {
    if (!url) return
    try {
        await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        })
    } catch (error) {
        console.error('Database dump callback failed:', error)
    }
}

export function createDatabaseDumpStream(
    dataSource: DataSource,
    config: StarbaseDBConfiguration,
    chunkSize = DEFAULT_EXPORT_CHUNK_SIZE
): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder()

    return new ReadableStream({
        async start(controller) {
            try {
                controller.enqueue(encoder.encode('SQLite format 3\0'))

                const tablesResult = await executeOperation(
                    [{ sql: "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;" }],
                    dataSource,
                    config
                )
                const tables = tablesResult.map((row: any) => row.name)

                for (const table of tables) {
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
                        controller.enqueue(
                            encoder.encode(`\n-- Table: ${table}\n${schemaResult[0].sql};\n\n`)
                        )
                    }

                    let offset = 0
                    while (true) {
                        const rows = await executeOperation(
                            [
                                {
                                    sql: `SELECT * FROM ${quoteIdentifier(table)} LIMIT ? OFFSET ?;`,
                                    params: [chunkSize, offset],
                                },
                            ],
                            dataSource,
                            config
                        )

                        if (!rows.length) break

                        let chunk = ''
                        for (const row of rows) {
                            const values = Object.values(row).map(sqlValue)
                            chunk += `INSERT INTO ${quoteIdentifier(table)} VALUES (${values.join(', ')});\n`
                        }
                        controller.enqueue(encoder.encode(chunk))

                        if (rows.length < chunkSize) break
                        offset += rows.length
                    }

                    controller.enqueue(encoder.encode('\n'))
                }

                controller.close()
            } catch (error) {
                controller.error(error)
            }
        },
    })
}

async function readManifest(bucket: R2Bucket, filename: string): Promise<AsyncDumpManifest | undefined> {
    const object = await bucket.get(manifestKey(filename))
    if (!object) return undefined
    return object.json<AsyncDumpManifest>()
}

async function writeManifest(bucket: R2Bucket, manifest: AsyncDumpManifest) {
    manifest.updatedAt = new Date().toISOString()
    await bucket.put(manifestKey(manifest.filename), JSON.stringify(manifest, null, 2), {
        httpMetadata: { contentType: 'application/json' },
    })
}

async function ensureManifest(
    bucket: R2Bucket,
    filename: string,
    callbackUrl: string | undefined,
    chunkSize: number
): Promise<AsyncDumpManifest> {
    const existing = await readManifest(bucket, filename)
    if (existing) return existing

    const now = new Date().toISOString()
    const manifest: AsyncDumpManifest = {
        status: 'running',
        filename,
        callbackUrl,
        chunkSize,
        tableIndex: 0,
        offset: 0,
        part: 0,
        createdAt: now,
        updatedAt: now,
    }
    await writeManifest(bucket, manifest)
    return manifest
}

async function writePart(bucket: R2Bucket, manifest: AsyncDumpManifest, body: string) {
    await bucket.put(partKey(manifest.filename, manifest.part), body, {
        httpMetadata: { contentType: 'application/sql' },
    })
    manifest.part += 1
}

async function processAsyncDumpSlice(
    bucket: R2Bucket,
    manifest: AsyncDumpManifest,
    dataSource: DataSource,
    config: StarbaseDBConfiguration,
    timeBudgetMs = DEFAULT_ASYNC_TIME_BUDGET_MS
) {
    const startedAt = Date.now()

    if (!manifest.tables) {
        const tablesResult = await executeOperation(
            [{ sql: "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;" }],
            dataSource,
            config
        )
        manifest.tables = tablesResult.map((row: any) => row.name)
        await writePart(bucket, manifest, 'SQLite format 3\0')
        await writeManifest(bucket, manifest)
    }

    while (manifest.tableIndex < manifest.tables.length) {
        const table = manifest.tables[manifest.tableIndex]

        if (manifest.offset === 0) {
            const schemaResult = await executeOperation(
                [{ sql: `SELECT sql FROM sqlite_master WHERE type='table' AND name=?;`, params: [table] }],
                dataSource,
                config
            )
            if (schemaResult.length) {
                await writePart(bucket, manifest, `\n-- Table: ${table}\n${schemaResult[0].sql};\n\n`)
            }
        }

        const rows = await executeOperation(
            [{ sql: `SELECT * FROM ${quoteIdentifier(table)} LIMIT ? OFFSET ?;`, params: [manifest.chunkSize, manifest.offset] }],
            dataSource,
            config
        )

        if (!rows.length) {
            await writePart(bucket, manifest, '\n')
            manifest.tableIndex += 1
            manifest.offset = 0
            await writeManifest(bucket, manifest)
            continue
        }

        let chunk = ''
        for (const row of rows) {
            const values = Object.values(row).map(sqlValue)
            chunk += `INSERT INTO ${quoteIdentifier(table)} VALUES (${values.join(', ')});\n`
        }
        await writePart(bucket, manifest, chunk)

        if (rows.length < manifest.chunkSize) {
            await writePart(bucket, manifest, '\n')
            manifest.tableIndex += 1
            manifest.offset = 0
        } else {
            manifest.offset += rows.length
        }

        await writeManifest(bucket, manifest)

        if (Date.now() - startedAt > timeBudgetMs) return
    }

    manifest.status = 'completed'
    await writeManifest(bucket, manifest)
    await notifyCallback(manifest.callbackUrl, { status: 'completed', filename: manifest.filename, parts: manifest.part })
}

async function createAsyncDump(
    request: Request,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
) {
    const bucket = config.export?.bucket
    if (!bucket) {
        return createResponse(
            undefined,
            'Async database dumps require an EXPORT_BUCKET R2 binding.',
            400
        )
    }

    const url = new URL(request.url)
    const filename = url.searchParams.get('filename') || dumpFilename()
    const callbackUrl = url.searchParams.get('callbackUrl') || config.export?.callbackUrl
    const chunkSize = Number(config.export?.chunkSize || DEFAULT_EXPORT_CHUNK_SIZE)

    const manifest = await ensureManifest(bucket, filename, callbackUrl, chunkSize)
    if (manifest.status === 'completed') {
        return createResponse({ filename, status: 'completed', parts: manifest.part }, undefined, 200)
    }

    try {
        await processAsyncDumpSlice(bucket, manifest, dataSource, config)
    } catch (error: any) {
        manifest.status = 'failed'
        manifest.error = error?.message || String(error)
        await writeManifest(bucket, manifest)
        await notifyCallback(callbackUrl, { status: 'failed', filename, error: manifest.error })
    }

    const latest = (await readManifest(bucket, filename)) || manifest
    const continueUrl = new URL(request.url)
    continueUrl.searchParams.set('async', 'true')
    continueUrl.searchParams.set('filename', filename)

    return createResponse(
        {
            filename,
            status: latest.status,
            parts: latest.part,
            tableIndex: latest.tableIndex,
            offset: latest.offset,
            continueUrl: latest.status === 'running' ? continueUrl.toString() : undefined,
            manifest: manifestKey(filename),
            partsPrefix: `${filename}.parts/`,
        },
        undefined,
        latest.status === 'completed' && manifest.tables ? 200 : 202
    )
}

export async function dumpDatabaseRoute(
    request: Request,
    dataSource: DataSource,
    config: StarbaseDBConfiguration
): Promise<Response> {
    try {
        if (new URL(request.url).searchParams.get('async') === 'true') {
            return createAsyncDump(request, dataSource, config)
        }

        const headers = new Headers({
            'Content-Type': 'application/x-sqlite3',
            'Content-Disposition': 'attachment; filename="database_dump.sql"',
        })

        return new Response(
            createDatabaseDumpStream(
                dataSource,
                config,
                config.export?.chunkSize || DEFAULT_EXPORT_CHUNK_SIZE
            ),
            { headers }
        )
    } catch (error: any) {
        console.error('Database Dump Error:', error)
        return createResponse(undefined, 'Failed to create database dump', 500)
    }
}
