import { DataSource } from '../types'
import { StarbaseDBConfiguration } from '../handler'
import { executeOperation } from './index'

export const DUMP_STATE_KEY = 'tmp_dump_state'
export const DUMP_CHUNK_KEY = 'tmp_dump_chunk'
export const MIN_R2_PART_SIZE_BYTES = 5 * 1024 * 1024

export const DEFAULT_DUMP_OPTIONS = {
    cycleTimeBudgetMs: 5_000,
    breathingIntervalMs: 5_000,
    rowsPerBatch: 500,
    chunkTargetBytes: 512 * 1024,
    finalizePartSizeBytes: MIN_R2_PART_SIZE_BYTES,
    finalizeTimeBudgetMs: 20_000,
} as const

export interface DumpOptions {
    cycleTimeBudgetMs?: number
    breathingIntervalMs?: number
    rowsPerBatch?: number
    chunkTargetBytes?: number
    finalizePartSizeBytes?: number
    finalizeTimeBudgetMs?: number
}

export type DumpPhase = 'schema' | 'table-data' | 'complete'
export type DumpCursorMode = 'rowid' | 'primary-key'
export type DumpCursorValue = string | number | bigint | null

export interface DumpState {
    dumpId: string
    fileName: string
    phase: DumpPhase
    tables: string[]
    tableIndex: number
    lastFetchedRowId: number | null
    chunkRowOffset: number
    bytesWritten: number
    chunkIndex: number
    startedAt: number
    updatedAt: number
    completedAt?: number
    totalRows: number
    finalObjectKey?: string
    finalObjectSize?: number
    finalizedAt?: number
    finalizeUploadId?: string
    finalizeParts?: R2UploadedPart[]
    finalizeBytes?: number
    finalizePartSizeBytes?: number
    currentTable?: string
    cursorMode?: DumpCursorMode
    cursorColumns?: string[]
    cursorAliases?: string[]
    cursorValues?: DumpCursorValue[] | null
    temporaryChunksCleanedAt?: number
}

export interface ChunkRecord {
    dumpId: string
    chunkIndex: number
    content: string
    bytes: number
    createdAt: number
}

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
const CURSOR_ALIAS_PREFIX = '__starbase_dump_cursor_'

export function isSafeIdentifier(name: string): boolean {
    return IDENTIFIER_PATTERN.test(name)
}

export function quoteIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`
}

export function sqlCommentLabel(value: string): string {
    return value.replace(/[\r\n]/g, ' ')
}

function sqlQuote(value: unknown): string {
    if (value === null || value === undefined) {
        return 'NULL'
    }
    if (typeof value === 'number') {
        return Number.isFinite(value) ? String(value) : 'NULL'
    }
    if (typeof value === 'bigint' || typeof value === 'boolean') {
        return String(value)
    }
    if (value instanceof ArrayBuffer) {
        return `X'${Array.from(new Uint8Array(value), (b) =>
            b.toString(16).padStart(2, '0')
        ).join('')}'`
    }
    if (ArrayBuffer.isView(value)) {
        return `X'${Array.from(
            new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
            (b) => b.toString(16).padStart(2, '0')
        ).join('')}'`
    }
    if (typeof value === 'string') {
        return `'${value.replace(/'/g, "''")}'`
    }
    const serialized = JSON.stringify(value)
    return `'${(serialized ?? String(value)).replace(/'/g, "''")}'`
}

export function serializeRows(
    table: string,
    rows: Record<string, unknown>[],
    columns?: string[]
): { content: string; rowCount: number } {
    if (rows.length === 0) {
        return { content: '', rowCount: 0 }
    }
    const selectedColumns = columns ?? Object.keys(rows[0])
    const columnList = selectedColumns.map((c) => quoteIdentifier(c)).join(', ')
    const lines = rows.map((row) => {
        const values = selectedColumns.map((c) => sqlQuote(row[c]))
        return `INSERT INTO ${quoteIdentifier(table)} (${columnList}) VALUES (${values.join(', ')});`
    })
    return { content: `${lines.join('\n')}\n`, rowCount: rows.length }
}

export function makeDumpFileName(now = new Date()): string {
    const pad = (n: number) => String(n).padStart(2, '0')
    const stamp =
        `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
        `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
    return `dump_${stamp}.sql`
}

type TableCursorPlan = {
    mode: DumpCursorMode
    columns: string[]
    aliases: string[]
}

type CursorRow = Record<string, unknown>

function dumpChunkKey(dumpId: string, chunkIndex: number): string {
    return `${dumpId}/${String(chunkIndex).padStart(8, '0')}.sql`
}

function normalizeCursorValue(value: unknown): DumpCursorValue {
    if (value === null || value === undefined) {
        return null
    }
    if (
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'bigint'
    ) {
        return value
    }
    return String(value)
}

function stripCursorColumns(
    row: CursorRow,
    aliases: string[]
): Record<string, unknown> {
    const result = { ...row }
    for (const alias of aliases) {
        delete result[alias]
    }
    return result
}

function rowCursorValues(row: CursorRow, aliases: string[]): DumpCursorValue[] {
    return aliases.map((alias) => normalizeCursorValue(row[alias]))
}

function makeCursorAliases(columns: string[]): string[] {
    const names = new Set(columns.map((column) => column.toLowerCase()))
    return columns.map((_, index) => {
        let alias = `${CURSOR_ALIAS_PREFIX}${index}`
        while (names.has(alias.toLowerCase())) {
            alias += '_'
        }
        return alias
    })
}

export function normalizePartSizeBytes(value: unknown): number {
    const numeric = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(numeric)) {
        return MIN_R2_PART_SIZE_BYTES
    }
    return Math.max(MIN_R2_PART_SIZE_BYTES, Math.floor(numeric))
}

export class ChunkedDumpEngine {
    constructor(
        private readonly storage: DurableObjectStorage,
        private readonly r2: R2Bucket | undefined,
        private readonly dataSource: DataSource,
        private readonly config: StarbaseDBConfiguration,
        options: Required<DumpOptions>
    ) {
        this.options = {
            ...options,
            finalizePartSizeBytes: normalizePartSizeBytes(
                options.finalizePartSizeBytes
            ),
        }
    }

    private readonly options: Required<DumpOptions>

    async startDump(): Promise<DumpState> {
        const existing = await this.storage.get<DumpState>(DUMP_STATE_KEY)
        if (existing) {
            return this.runCycle()
        }

        const tablesResult = await executeOperation(
            [
                {
                    sql: "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'tmp_%';",
                },
            ],
            this.dataSource,
            this.config
        )
        const tables = tablesResult
            .map((row: Record<string, unknown>) => String(row.name))
            .filter((name) => name.length > 0)

        const now = Date.now()
        const state: DumpState = {
            dumpId: `dump_${now.toString(36)}`,
            fileName: makeDumpFileName(new Date(now)),
            phase: 'schema',
            tables,
            tableIndex: 0,
            lastFetchedRowId: null,
            chunkRowOffset: 0,
            bytesWritten: 0,
            chunkIndex: 0,
            startedAt: now,
            updatedAt: now,
            totalRows: 0,
            finalizePartSizeBytes: this.options.finalizePartSizeBytes,
        }
        await this.storage.put(DUMP_STATE_KEY, state)
        return this.runCycle()
    }

    async getState(): Promise<DumpState | undefined> {
        return this.storage.get<DumpState>(DUMP_STATE_KEY)
    }

    async runCycle(): Promise<DumpState> {
        const state = (await this.storage.get<DumpState>(
            DUMP_STATE_KEY
        )) as DumpState
        if (!state) {
            throw new Error('No dump in progress')
        }
        if (state.completedAt) {
            return state
        }

        const cycleStart = Date.now()
        let content = ''
        let contentBytes = 0
        let chunkDirty = false

        const flushChunk = async () => {
            if (!chunkDirty) {
                return
            }
            const record: ChunkRecord = {
                dumpId: state.dumpId,
                chunkIndex: state.chunkIndex,
                content,
                bytes: contentBytes,
                createdAt: Date.now(),
            }
            if (this.r2) {
                await this.r2.put(
                    dumpChunkKey(state.dumpId, record.chunkIndex),
                    record.content
                )
            }
            await this.storage.put(
                `${DUMP_CHUNK_KEY}:${record.chunkIndex}`,
                record
            )
            state.chunkIndex += 1
            state.bytesWritten += contentBytes
            content = ''
            contentBytes = 0
            chunkDirty = false
        }

        const persist = async () => {
            state.updatedAt = Date.now()
            await this.storage.put(DUMP_STATE_KEY, state)
        }

        if (state.phase === 'schema') {
            while (state.tableIndex < state.tables.length) {
                const table = state.tables[state.tableIndex]
                state.tableIndex++
                const schemaResult = await executeOperation(
                    [
                        {
                            sql: "SELECT sql FROM sqlite_master WHERE type='table' AND name=?;",
                            params: [table],
                        },
                    ],
                    this.dataSource,
                    this.config
                )
                if (schemaResult.length && schemaResult[0]?.sql) {
                    const ddl = `\n-- Table: ${sqlCommentLabel(table)}\n${String(schemaResult[0].sql)};\n\n`
                    content += ddl
                    contentBytes += ddl.length
                    chunkDirty = true
                }
                if (
                    contentBytes >= this.options.chunkTargetBytes ||
                    Date.now() - cycleStart >= this.options.cycleTimeBudgetMs
                ) {
                    await flushChunk()
                    await persist()
                    return state
                }
            }
            state.phase = 'table-data'
            state.tableIndex = 0
        }

        while (state.tableIndex < state.tables.length) {
            const table = state.tables[state.tableIndex]
            const hasLegacyRowIdCursor =
                state.currentTable === undefined &&
                state.cursorMode === undefined &&
                state.lastFetchedRowId !== null
            if (state.currentTable !== table) {
                state.currentTable = table
                state.cursorMode = undefined
                state.cursorColumns = undefined
                state.cursorAliases = undefined
                state.cursorValues = null
                if (!hasLegacyRowIdCursor) {
                    state.lastFetchedRowId = null
                }
            }

            const plan = await this.resolveTableCursor(table, state)
            const aliases = state.cursorAliases ?? plan.aliases
            const cursorColumns = state.cursorColumns ?? plan.columns
            const cursorValues =
                state.cursorValues ??
                (state.cursorMode === 'rowid' && state.lastFetchedRowId !== null
                    ? [state.lastFetchedRowId]
                    : null)
            if (cursorValues && !state.cursorValues) {
                state.cursorValues = cursorValues
            }
            const limit = Math.max(1, Math.floor(this.options.rowsPerBatch))
            const selectedCursorColumns = cursorColumns
                .map(
                    (column, index) =>
                        `${quoteIdentifier(column)} AS ${quoteIdentifier(aliases[index])}`
                )
                .join(', ')
            const orderColumns = cursorColumns
                .map((column) => quoteIdentifier(column))
                .join(', ')
            const where =
                cursorValues && cursorValues.length === cursorColumns.length
                    ? state.cursorMode === 'rowid'
                        ? ` WHERE ${quoteIdentifier(cursorColumns[0])} > ?`
                        : ` WHERE (${cursorColumns.map((column) => quoteIdentifier(column)).join(', ')}) > (${cursorValues.map(() => '?').join(', ')})`
                    : ''
            const params = cursorValues ? [...cursorValues] : []
            const rowsResult = ((await executeOperation(
                [
                    {
                        sql: `SELECT ${selectedCursorColumns}, * FROM ${quoteIdentifier(table)}${where} ORDER BY ${orderColumns} LIMIT ${limit};`,
                        params,
                    },
                ],
                this.dataSource,
                this.config
            )) ?? []) as CursorRow[]

            if (rowsResult.length === 0) {
                state.tableIndex++
                state.currentTable = undefined
                state.cursorMode = undefined
                state.cursorColumns = undefined
                state.cursorAliases = undefined
                state.cursorValues = null
                state.lastFetchedRowId = null
                continue
            }

            const nextCursor = rowCursorValues(
                rowsResult[rowsResult.length - 1],
                aliases
            )
            state.cursorValues = nextCursor
            if (state.cursorMode === 'rowid') {
                const numeric = Number(nextCursor[0])
                state.lastFetchedRowId = Number.isFinite(numeric)
                    ? numeric
                    : null
            }

            const rows = rowsResult.map((row) =>
                stripCursorColumns(row, aliases)
            )
            const { content: batchSql, rowCount } = serializeRows(table, rows)
            content += batchSql
            contentBytes += batchSql.length
            state.totalRows += rowCount
            state.chunkRowOffset += rowCount
            chunkDirty = true

            if (
                contentBytes >= this.options.chunkTargetBytes ||
                Date.now() - cycleStart >= this.options.cycleTimeBudgetMs
            ) {
                await flushChunk()
                await persist()
                return state
            }
        }

        const done = `\n-- Dump complete: ${state.totalRows} rows, ${state.chunkIndex + (chunkDirty ? 1 : 0)} chunks.\n`
        content += done
        contentBytes += done.length
        chunkDirty = true
        await flushChunk()

        state.phase = 'complete'
        state.completedAt = Date.now()
        await persist()
        return state
    }

    shouldContinue(state: DumpState, requestStart: number): boolean {
        if (state.completedAt) return false
        return Date.now() - requestStart < this.options.cycleTimeBudgetMs
    }

    breathingDelayMs(): number {
        return this.options.breathingIntervalMs
    }

    async finalizeDump(
        options: { partSizeBytes?: number; timeBudgetMs?: number } = {}
    ): Promise<{ done: boolean; state: DumpState }> {
        const state = (await this.storage.get<DumpState>(
            DUMP_STATE_KEY
        )) as DumpState
        if (!state) {
            throw new Error('No dump in progress')
        }

        const persistedPartSize = state.finalizePartSizeBytes
        const requestedPartSize =
            persistedPartSize ??
            options.partSizeBytes ??
            this.options.finalizePartSizeBytes
        const partSize = normalizePartSizeBytes(requestedPartSize)
        const partSizeChanged = state.finalizePartSizeBytes !== partSize
        const resetMultipart =
            Boolean(state.finalizeUploadId) &&
            (persistedPartSize === undefined || persistedPartSize !== partSize)
        if (partSizeChanged) {
            state.finalizePartSizeBytes = partSize
        }
        const persistPartSize = async () => {
            if (!partSizeChanged) return
            state.updatedAt = Date.now()
            await this.storage.put(DUMP_STATE_KEY, state)
        }

        if (!state.completedAt) {
            await persistPartSize()
            return { done: false, state }
        }
        if (state.finalizedAt) {
            await persistPartSize()
            if (this.r2 && !state.temporaryChunksCleanedAt) {
                const cleaned = await this.cleanupTemporaryChunks(state)
                return { done: cleaned, state }
            }
            return { done: true, state }
        }
        if (!this.r2) {
            await persistPartSize()
            state.finalizedAt = Date.now()
            state.updatedAt = state.finalizedAt
            await this.storage.put(DUMP_STATE_KEY, state)
            return { done: true, state }
        }

        const budget = options.timeBudgetMs ?? this.options.finalizeTimeBudgetMs
        const key =
            state.finalObjectKey ?? `dumps/${state.dumpId}/${state.fileName}`
        let multipartReset = false
        if (resetMultipart && state.finalizeUploadId) {
            const upload = this.r2.resumeMultipartUpload(
                key,
                state.finalizeUploadId
            )
            try {
                await upload.abort()
            } catch {
                return { done: false, state }
            }
            state.finalizeUploadId = undefined
            state.finalizeParts = undefined
            state.finalizeBytes = undefined
            multipartReset = true
        }
        if (partSizeChanged || multipartReset) {
            state.updatedAt = Date.now()
            await this.storage.put(DUMP_STATE_KEY, state)
        }
        const hasContent = await this.hasChunkContent(state)
        if (!hasContent) {
            if (state.bytesWritten > 0) {
                throw new Error('Dump chunk data is missing')
            }
            return this.finalizeEmptyDump(state, key)
        }

        const cycleStart = Date.now()
        let mpu: R2MultipartUpload
        if (state.finalizeUploadId) {
            mpu = this.r2.resumeMultipartUpload(key, state.finalizeUploadId)
        } else {
            mpu = await this.r2.createMultipartUpload(key)
            state.finalObjectKey = key
            state.finalizeUploadId = mpu.uploadId
            state.finalizeParts = []
            state.finalizeBytes = 0
            await this.storage.put(DUMP_STATE_KEY, state)
        }

        const parts = state.finalizeParts ?? []
        const encoder = new TextEncoder()
        const persist = async () => {
            state.finalizeParts = parts
            state.updatedAt = Date.now()
            await this.storage.put(DUMP_STATE_KEY, state)
        }

        let skipped = Math.max(0, state.finalizeBytes ?? 0)
        let partNumber = parts.length + 1
        const buffer = new Uint8Array(partSize)
        let bufferLength = 0

        for (let i = 0; i < state.chunkIndex; i++) {
            const record = await this.storage.get<ChunkRecord>(
                `${DUMP_CHUNK_KEY}:${i}`
            )
            if (!record?.content) continue
            const encoded = encoder.encode(record.content)
            let offset = 0
            if (skipped >= encoded.length) {
                skipped -= encoded.length
                continue
            }
            if (skipped > 0) {
                offset = skipped
                skipped = 0
            }

            while (offset < encoded.length) {
                const length = Math.min(
                    partSize - bufferLength,
                    encoded.length - offset
                )
                buffer.set(
                    encoded.subarray(offset, offset + length),
                    bufferLength
                )
                bufferLength += length
                offset += length

                if (bufferLength === partSize) {
                    if (Date.now() - cycleStart >= budget) {
                        await persist()
                        return { done: false, state }
                    }
                    const part = await mpu.uploadPart(
                        partNumber,
                        buffer.slice(0, partSize)
                    )
                    parts.push({ partNumber, etag: part.etag })
                    state.finalizeBytes = (state.finalizeBytes ?? 0) + partSize
                    bufferLength = 0
                    await persist()
                    partNumber++
                }
            }
        }

        if (bufferLength > 0) {
            if (Date.now() - cycleStart >= budget) {
                await persist()
                return { done: false, state }
            }
            const part = await mpu.uploadPart(
                partNumber,
                buffer.slice(0, bufferLength)
            )
            parts.push({ partNumber, etag: part.etag })
            state.finalizeBytes = (state.finalizeBytes ?? 0) + bufferLength
            bufferLength = 0
            await persist()
        }

        if (parts.length === 0) {
            return { done: false, state }
        }

        const object = await mpu.complete(parts)
        state.finalObjectKey = key
        state.finalObjectSize = object?.size ?? state.finalizeBytes
        state.finalizedAt = Date.now()
        state.updatedAt = state.finalizedAt
        state.finalizeUploadId = undefined
        state.finalizeParts = undefined
        state.finalizeBytes = undefined
        await this.storage.put(DUMP_STATE_KEY, state)

        const cleaned = await this.cleanupTemporaryChunks(state)
        return { done: cleaned, state }
    }

    async getPresignedUrl(expiresInSeconds = 3600): Promise<string | null> {
        const state = (await this.storage.get<DumpState>(
            DUMP_STATE_KEY
        )) as DumpState
        if (!state?.finalObjectKey || !this.r2) return null
        const creator = (
            this.r2 as R2Bucket & { createSignedUrl?: R2SignedUrlCreator }
        ).createSignedUrl
        if (typeof creator !== 'function') return null
        try {
            const signed = await creator.call(
                this.r2,
                state.finalObjectKey,
                expiresInSeconds
            )
            return signed?.url ?? null
        } catch {
            return null
        }
    }

    async assembleDump(
        state: DumpState
    ): Promise<ReadableStream<Uint8Array> | null> {
        if (!state.completedAt) return null

        if (state.finalObjectKey && this.r2) {
            const final = await this.r2.get(state.finalObjectKey)
            if (final?.body) return final.body
        }

        if (state.temporaryChunksCleanedAt) {
            return null
        }

        if (this.r2) {
            const stream = await this.concatenateR2(state)
            if (stream) return stream
        }

        const storage = this.storage
        return new ReadableStream<Uint8Array>({
            async start(controller) {
                const encoder = new TextEncoder()
                for (let i = 0; i < state.chunkIndex; i++) {
                    const record = await storage.get<ChunkRecord>(
                        `${DUMP_CHUNK_KEY}:${i}`
                    )
                    if (record?.content) {
                        controller.enqueue(encoder.encode(record.content))
                    }
                }
                controller.close()
            },
        })
    }

    private async resolveTableCursor(
        table: string,
        state: DumpState
    ): Promise<TableCursorPlan> {
        if (state.cursorMode && state.cursorColumns && state.cursorAliases) {
            return {
                mode: state.cursorMode,
                columns: state.cursorColumns,
                aliases: state.cursorAliases,
            }
        }

        const tableInfo = ((await executeOperation(
            [{ sql: `PRAGMA table_info(${quoteIdentifier(table)});` }],
            this.dataSource,
            this.config
        )) ?? []) as Record<string, unknown>[]
        const columns = tableInfo.map((row) => String(row.name))
        const primaryKey = tableInfo
            .filter((row) => Number(row.pk) > 0)
            .sort((left, right) => Number(left.pk) - Number(right.pk))
            .map((row) => String(row.name))

        const rowidAliases = ['rowid', '_rowid_', 'oid'].filter(
            (alias) => !columns.some((column) => column.toLowerCase() === alias)
        )
        for (const alias of rowidAliases) {
            try {
                await executeOperation(
                    [
                        {
                            sql: `SELECT ${quoteIdentifier(alias)} AS ${quoteIdentifier(`${CURSOR_ALIAS_PREFIX}probe`)} FROM ${quoteIdentifier(table)} LIMIT 0;`,
                        },
                    ],
                    this.dataSource,
                    this.config
                )
                const plan = {
                    mode: 'rowid' as const,
                    columns: [alias],
                    aliases: makeCursorAliases([alias]),
                }
                state.cursorMode = plan.mode
                state.cursorColumns = plan.columns
                state.cursorAliases = plan.aliases
                state.cursorValues = null
                return plan
            } catch {}
        }

        if (primaryKey.length === 0) {
            throw new Error(
                `Cannot determine a stable cursor for table ${table}`
            )
        }
        const plan = {
            mode: 'primary-key' as const,
            columns: primaryKey,
            aliases: makeCursorAliases(primaryKey),
        }
        state.cursorMode = plan.mode
        state.cursorColumns = plan.columns
        state.cursorAliases = plan.aliases
        state.cursorValues = null
        return plan
    }

    private async hasChunkContent(state: DumpState): Promise<boolean> {
        for (let i = 0; i < state.chunkIndex; i++) {
            const record = await this.storage.get<ChunkRecord>(
                `${DUMP_CHUNK_KEY}:${i}`
            )
            if (record?.content) {
                return true
            }
        }
        return false
    }

    private async finalizeEmptyDump(
        state: DumpState,
        key: string
    ): Promise<{ done: boolean; state: DumpState }> {
        const r2 = this.r2
        if (!r2) {
            throw new Error(
                'R2 binding is required for empty dump finalization'
            )
        }
        if (state.finalizeUploadId) {
            const upload = r2.resumeMultipartUpload(key, state.finalizeUploadId)
            try {
                await upload.abort()
            } catch {
                return { done: false, state }
            }
            state.finalizeUploadId = undefined
            state.finalizeParts = undefined
            state.finalizeBytes = undefined
            state.updatedAt = Date.now()
            await this.storage.put(DUMP_STATE_KEY, state)
        }

        await r2.put(key, new Uint8Array(0))
        state.finalObjectKey = key
        state.finalObjectSize = 0
        state.finalizedAt = Date.now()
        state.updatedAt = state.finalizedAt
        state.finalizeUploadId = undefined
        state.finalizeParts = undefined
        state.finalizeBytes = undefined
        await this.storage.put(DUMP_STATE_KEY, state)
        const cleaned = await this.cleanupTemporaryChunks(state)
        return { done: cleaned, state }
    }

    private async cleanupTemporaryChunks(state: DumpState): Promise<boolean> {
        let complete = true
        for (let i = 0; i < state.chunkIndex; i++) {
            let r2Deleted = true
            if (this.r2) {
                try {
                    await this.r2.delete(dumpChunkKey(state.dumpId, i))
                } catch {
                    r2Deleted = false
                    complete = false
                }
            }
            if (!r2Deleted) {
                continue
            }
            try {
                await this.storage.delete(`${DUMP_CHUNK_KEY}:${i}`)
            } catch {
                complete = false
            }
        }
        if (complete) {
            state.temporaryChunksCleanedAt = Date.now()
        }
        state.updatedAt = Date.now()
        await this.storage.put(DUMP_STATE_KEY, state)
        return complete
    }

    private async concatenateR2(
        state: DumpState
    ): Promise<ReadableStream<Uint8Array> | null> {
        if (!this.r2) return null
        const head = await this.r2.get(dumpChunkKey(state.dumpId, 0))
        if (!head) return null
        const parts: ReadableStream<Uint8Array>[] = []
        for (let i = 0; i < state.chunkIndex; i++) {
            const obj = await this.r2.get(dumpChunkKey(state.dumpId, i))
            if (obj?.body) {
                parts.push(obj.body)
            }
        }
        return concatStreams(parts)
    }
}

type R2SignedUrlCreator = (
    key: string,
    expiresInSeconds: number
) => Promise<{ url?: string } | null>

function concatStreams(
    streams: ReadableStream<Uint8Array>[]
): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
        async start(controller) {
            for (const stream of streams) {
                const reader = stream.getReader()
                for (;;) {
                    const { done, value } = await reader.read()
                    if (done) break
                    controller.enqueue(value)
                }
                reader.releaseLock()
            }
            controller.close()
        },
    })
}
