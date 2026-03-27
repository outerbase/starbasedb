const ROWS_PER_BATCH = 1_000
/** R2 requires each multipart part (except the last) to be at least 5 MiB. */
const MIN_MULTIPART_PART_SIZE = 5 * 1024 * 1024
/** Process for at most ~20 s per alarm cycle to stay well within the 30 s limit. */
const MAX_ALARM_DURATION_MS = 20_000
/** DO storage max value size is 128 KiB; use 64 KiB chunks for the pending buffer. */
const STORAGE_CHUNK_SIZE = 64 * 1024
/** Maximum time a dump can remain in 'running' state before being considered stale (1 hour). */
const MAX_DUMP_DURATION_MS = 60 * 60 * 1_000

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DumpState {
    dumpId: string
    status: 'running' | 'complete' | 'failed'
    tables: string[]
    /** Index of the table currently being processed. */
    currentTableIndex: number
    /** Row OFFSET into the current table that has been READ (not necessarily flushed to R2). */
    currentOffset: number
    /** Row OFFSET into the current table that has been COMMITTED to R2. */
    committedOffset: number
    /** Table index that has been fully committed to R2. */
    committedTableIndex: number
    uploadKey: string
    uploadId: string
    parts: Array<{ partNumber: number; etag: string }>
    nextPartNumber: number
    /** Number of 64 KiB chunks used to store the pending buffer. */
    pendingBufferChunks: number
    callbackUrl?: string
    startedAt: number
    completedAt?: number
    error?: string
}

export interface DumpStatus {
    dumpId: string
    status: DumpState['status']
    progress?: {
        processedTables: number
        totalTables: number
        currentTable?: string
    }
    downloadPath?: string
    error?: string
}

// ─── Buffer storage helpers ───────────────────────────────────────────────────

async function savePendingBuffer(
    storage: DurableObjectStorage,
    dumpId: string,
    buffer: string
): Promise<number> {
    if (buffer.length === 0) {
        await storage.delete(`dump:${dumpId}:buf:count`)
        return 0
    }
    const numChunks = Math.ceil(buffer.length / STORAGE_CHUNK_SIZE)
    const puts: Promise<void>[] = []
    for (let i = 0; i < numChunks; i++) {
        const chunk = buffer.slice(
            i * STORAGE_CHUNK_SIZE,
            (i + 1) * STORAGE_CHUNK_SIZE
        )
        puts.push(storage.put(`dump:${dumpId}:buf:${i}`, chunk))
    }
    puts.push(storage.put(`dump:${dumpId}:buf:count`, numChunks))
    await Promise.all(puts)
    return numChunks
}

async function loadPendingBuffer(
    storage: DurableObjectStorage,
    dumpId: string,
    numChunks: number
): Promise<string> {
    if (numChunks === 0) return ''
    const chunks = await Promise.all(
        Array.from({ length: numChunks }, (_, i) =>
            storage.get<string>(`dump:${dumpId}:buf:${i}`)
        )
    )
    return chunks.filter((c): c is string => c !== null).join('')
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Initiates an asynchronous database dump.
 * The DO alarm is NOT set here — the caller must schedule one after this returns.
 */
export async function initiateDump(
    sql: SqlStorage,
    r2Bucket: R2Bucket,
    storage: DurableObjectStorage,
    callbackUrl?: string
): Promise<{ dumpId: string }> {
    // Reject concurrent dumps (auto-expire stale ones)
    const existingId = await storage.get<string>('activeDumpId')
    if (existingId) {
        const existing = await storage.get<DumpState>(`dump:${existingId}`)
        if (existing?.status === 'running') {
            if (Date.now() - existing.startedAt > MAX_DUMP_DURATION_MS) {
                await storage.put(`dump:${existingId}`, {
                    ...existing,
                    status: 'failed',
                    error: 'Dump timed out after 1 hour',
                    completedAt: Date.now(),
                })
                await storage.delete('activeDumpId')
            } else {
                throw new Error(
                    `A dump is already in progress (id: ${existingId}). ` +
                        `Check GET /export/dump/${existingId} for status.`
                )
            }
        }
    }

    // List all user tables (exclude internal tmp_ tables)
    const tablesCursor = sql.exec<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'tmp_%' ORDER BY name;"
    )
    const tables = tablesCursor.toArray().map((r) => r.name)

    const dumpId = crypto.randomUUID()
    const timestamp = new Date()
        .toISOString()
        .replace(/[:.]/g, '-')
        .slice(0, 19)
    const uploadKey = `dump_${timestamp}_${dumpId.slice(0, 8)}.sql`

    const mpu = await r2Bucket.createMultipartUpload(uploadKey)

    const header =
        `-- StarbaseDB database dump\n` +
        `-- Generated: ${new Date().toISOString()}\n\n`

    const numChunks = await savePendingBuffer(storage, dumpId, header)

    const state: DumpState = {
        dumpId,
        status: 'running',
        tables,
        currentTableIndex: 0,
        currentOffset: 0,
        committedOffset: 0,
        committedTableIndex: 0,
        uploadKey,
        uploadId: mpu.uploadId,
        parts: [],
        nextPartNumber: 1,
        pendingBufferChunks: numChunks,
        callbackUrl,
        startedAt: Date.now(),
    }

    await storage.put(`dump:${dumpId}`, state)
    await storage.put('activeDumpId', dumpId)
    return { dumpId }
}

/**
 * Processes one chunk of dump work in the current alarm invocation.
 *
 * @returns `true` when the dump is fully complete, `false` if more work remains.
 */
export async function processDumpChunk(
    sql: SqlStorage,
    r2Bucket: R2Bucket,
    storage: DurableObjectStorage,
    dumpId: string
): Promise<boolean> {
    const state = await storage.get<DumpState>(`dump:${dumpId}`)
    if (!state || state.status !== 'running') return true

    const alarmStart = Date.now()
    const mpu = r2Bucket.resumeMultipartUpload(state.uploadKey, state.uploadId)

    // Restore mutable state from storage
    let {
        currentTableIndex,
        currentOffset,
        committedOffset,
        committedTableIndex,
        parts,
        nextPartNumber,
    } = state
    let pendingBuffer = await loadPendingBuffer(
        storage,
        dumpId,
        state.pendingBufferChunks
    )

    const flushPart = async () => {
        const part = await mpu.uploadPart(nextPartNumber, pendingBuffer)
        parts = [...parts, { partNumber: nextPartNumber, etag: part.etag }]
        nextPartNumber++
        committedTableIndex = currentTableIndex
        committedOffset = currentOffset
        pendingBuffer = ''
    }

    try {
        while (currentTableIndex < state.tables.length) {
            const table = state.tables[currentTableIndex]

            // Escape double-quotes in table names for use in SQL identifiers
            const escapedTable = table.replace(/"/g, '""')

            // Emit DDL on the first row of each table
            if (currentOffset === 0) {
                const ddlCursor = sql.exec<{ sql: string | null }>(
                    `SELECT sql FROM sqlite_master WHERE type='table' AND name=?;`,
                    table
                )
                const ddlRows = ddlCursor.toArray()
                if (ddlRows.length && ddlRows[0].sql) {
                    pendingBuffer += `-- Table: ${table.replace(/\n/g, ' ')}\n${ddlRows[0].sql};\n`
                }
            }

            // Read rows in batches
            const dataCursor = sql.exec<Record<string, SqlStorageValue>>(
                `SELECT * FROM "${escapedTable}" LIMIT ? OFFSET ?;`,
                ROWS_PER_BATCH,
                currentOffset
            )
            const rows = dataCursor.toArray()

            for (const row of rows) {
                const columns = Object.keys(row)
                    .map((c) => `"${c.replace(/"/g, '""')}"`)
                    .join(', ')
                const values = Object.values(row)
                    .map((v) => {
                        if (v === null || v === undefined) return 'NULL'
                        if (typeof v === 'number' || typeof v === 'bigint')
                            return String(v)
                        if (typeof v === 'string')
                            return `'${v.replace(/'/g, "''")}'`
                        if (v instanceof ArrayBuffer) {
                            const hex = Array.from(new Uint8Array(v))
                                .map((b) => b.toString(16).padStart(2, '0'))
                                .join('')
                            return `X'${hex}'`
                        }
                        return `'${String(v).replace(/'/g, "''")}'`
                    })
                    .join(', ')
                pendingBuffer += `INSERT INTO "${escapedTable}" (${columns}) VALUES (${values});\n`
            }

            if (rows.length < ROWS_PER_BATCH) {
                // Table complete
                pendingBuffer += '\n'
                currentTableIndex++
                currentOffset = 0
            } else {
                currentOffset += ROWS_PER_BATCH
            }

            // Flush to R2 when buffer is large enough for a multipart part
            if (pendingBuffer.length >= MIN_MULTIPART_PART_SIZE) {
                await flushPart()
            }

            // Yield if running low on alarm time
            if (Date.now() - alarmStart >= MAX_ALARM_DURATION_MS) {
                const numChunks = await savePendingBuffer(
                    storage,
                    dumpId,
                    pendingBuffer
                )
                await storage.put(`dump:${dumpId}`, {
                    ...state,
                    currentTableIndex,
                    currentOffset,
                    committedOffset,
                    committedTableIndex,
                    parts,
                    nextPartNumber,
                    pendingBufferChunks: numChunks,
                })
                return false
            }
        }

        // All tables processed — flush the remaining buffer as the final part.
        // initiateDump always writes a header to pendingBuffer, so parts will
        // have at least one entry after this flush.
        if (pendingBuffer.length > 0) {
            await flushPart()
        }

        await mpu.complete(parts)

        // Clean up buffer chunks from storage
        const deleteOps = Array.from(
            { length: state.pendingBufferChunks },
            (_, i) => storage.delete(`dump:${dumpId}:buf:${i}`)
        )
        await Promise.all([
            ...deleteOps,
            storage.delete(`dump:${dumpId}:buf:count`),
        ])

        const completedState: DumpState = {
            ...state,
            status: 'complete',
            currentTableIndex: state.tables.length,
            parts,
            pendingBufferChunks: 0,
            completedAt: Date.now(),
        }
        await storage.put(`dump:${dumpId}`, completedState)
        await storage.delete('activeDumpId')

        if (state.callbackUrl) {
            try {
                await fetch(state.callbackUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        event: 'dump_complete',
                        dumpId,
                        downloadPath: `/export/dump/${dumpId}/download`,
                        completedAt: new Date(
                            completedState.completedAt!
                        ).toISOString(),
                    }),
                })
            } catch {
                // Non-fatal: a callback failure does not invalidate the dump
            }
        }

        return true
    } catch (error: any) {
        try {
            await mpu.abort()
        } catch {}
        await storage.put(`dump:${dumpId}`, {
            ...state,
            status: 'failed',
            error: error?.message ?? 'Unknown error during dump processing',
            completedAt: Date.now(),
        })
        await storage.delete('activeDumpId')
        return true
    }
}

/**
 * Returns the current status of a dump job, or `null` if the dumpId is unknown.
 */
export async function getDumpStatus(
    storage: DurableObjectStorage,
    dumpId: string
): Promise<DumpStatus | null> {
    const state = await storage.get<DumpState>(`dump:${dumpId}`)
    if (!state) return null

    return {
        dumpId: state.dumpId,
        status: state.status,
        progress: {
            processedTables: state.currentTableIndex,
            totalTables: state.tables.length,
            currentTable:
                state.currentTableIndex < state.tables.length
                    ? state.tables[state.currentTableIndex]
                    : undefined,
        },
        downloadPath:
            state.status === 'complete'
                ? `/export/dump/${dumpId}/download`
                : undefined,
        error: state.error,
    }
}
