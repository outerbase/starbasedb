import type { DataSource } from '../../src/types'
import type {
    DataSyncPluginConfig,
    SyncRunSummary,
    TableSyncJob,
    TableSyncResult,
    SyncStatusState,
} from './types'
import type { ExternalReadAdapter } from './adapter'
import { quotePgIdent } from './adapter'

export const META_TABLE = 'tmp_data_sync_meta'
export const LOG_TABLE = 'tmp_data_sync_log'

const SQLITE_IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/

export function assertSqliteIdent(name: string, label: string): void {
    if (!SQLITE_IDENT.test(name)) {
        throw new Error(`[data-sync] Invalid SQLite ${label}: ${name}`)
    }
}

/** Normalize driver values into SQLite-friendly primitives */
export function mapValueForSqlite(value: unknown): unknown {
    if (value === null || value === undefined) return null
    if (typeof value === 'bigint') return value.toString()
    if (value instanceof Date) return value.toISOString()
    if (typeof value === 'object') {
        try {
            return JSON.stringify(value)
        } catch {
            return String(value)
        }
    }
    return value
}

export function buildRowForLocal(
    row: Record<string, unknown>,
    job: TableSyncJob
): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    if (job.columnMap) {
        for (const [extCol, locCol] of Object.entries(job.columnMap)) {
            assertSqliteIdent(locCol, 'column name')
            if (Object.prototype.hasOwnProperty.call(row, extCol)) {
                out[locCol] = mapValueForSqlite(row[extCol])
            }
        }
        return out
    }
    for (const [k, v] of Object.entries(row)) {
        const loc = k
        assertSqliteIdent(loc, 'column name')
        out[loc] = mapValueForSqlite(v)
    }
    return out
}

function quoteSqliteIdent(name: string): string {
    assertSqliteIdent(name, 'identifier')
    return `"${name.replace(/"/g, '""')}"`
}

/**
 * Build a multi-row UPSERT for SQLite (idempotent when PK matches).
 */
export function buildBatchUpsert(
    job: TableSyncJob,
    rows: Record<string, unknown>[]
): { sql: string; params: unknown[] } | null {
    if (!rows.length) return null

    const columns = Object.keys(rows[0])
    for (const r of rows) {
        const keys = Object.keys(r)
        if (
            keys.length !== columns.length ||
            keys.some((k) => !columns.includes(k))
        ) {
            throw new Error('[data-sync] Inconsistent row shape in batch')
        }
    }

    for (const pk of job.pkColumns) {
        assertSqliteIdent(pk, 'pk column')
    }

    const tableSql = quoteSqliteIdent(job.localTable)
    const colSql = columns.map(quoteSqliteIdent).join(', ')
    const pkSql = job.pkColumns.map(quoteSqliteIdent).join(', ')

    const valueTuples: string[] = []
    const params: unknown[] = []
    for (const r of rows) {
        const ph = columns.map(() => '?').join(', ')
        valueTuples.push(`(${ph})`)
        for (const c of columns) {
            params.push(r[c] ?? null)
        }
    }

    const nonPk = columns.filter((c) => !job.pkColumns.includes(c))
    const updateClause =
        nonPk.length > 0
            ? nonPk
                  .map(
                      (c) =>
                          `${quoteSqliteIdent(c)} = excluded.${quoteSqliteIdent(c)}`
                  )
                  .join(', ')
            : job.pkColumns[0]
              ? `${quoteSqliteIdent(job.pkColumns[0])} = excluded.${quoteSqliteIdent(job.pkColumns[0])}`
              : '1 = 1'

    const sql = `INSERT INTO ${tableSql} (${colSql}) VALUES ${valueTuples.join(', ')}
        ON CONFLICT(${pkSql}) DO UPDATE SET ${updateClause}`

    return { sql, params }
}

export async function ensureDataSyncTables(
    rpc: DataSource['rpc']
): Promise<void> {
    await rpc.executeQuery({
        sql: `
        CREATE TABLE IF NOT EXISTS ${META_TABLE} (
            table_name TEXT NOT NULL PRIMARY KEY,
            last_synced_at TEXT,
            last_cursor_id TEXT,
            last_cursor_ts TEXT,
            sync_status TEXT NOT NULL DEFAULT 'idle',
            error_message TEXT,
            rows_last_run INTEGER DEFAULT 0,
            updated_at TEXT DEFAULT (datetime('now'))
        )`,
        params: [],
    })
    await rpc.executeQuery({
        sql: `
        CREATE TABLE IF NOT EXISTS ${LOG_TABLE} (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            level TEXT NOT NULL,
            scope TEXT NOT NULL,
            message TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now'))
        )`,
        params: [],
    })
}

export async function appendLog(
    rpc: DataSource['rpc'],
    level: 'info' | 'warn' | 'error',
    scope: string,
    message: string
): Promise<void> {
    try {
        await rpc.executeQuery({
            sql: `INSERT INTO ${LOG_TABLE} (level, scope, message) VALUES (?, ?, ?)`,
            params: [level, scope, message],
        })
        await rpc.executeQuery({
            sql: `DELETE FROM ${LOG_TABLE} WHERE id NOT IN (
                SELECT id FROM ${LOG_TABLE} ORDER BY id DESC LIMIT 500
            )`,
            params: [],
        })
    } catch (e) {
        console.error('[data-sync] log insert failed:', e)
    }
}

async function withRetry<T>(
    fn: () => Promise<T>,
    opts: { maxRetries: number; baseMs: number }
): Promise<T> {
    let last: unknown
    for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
        try {
            return await fn()
        } catch (e) {
            last = e
            if (attempt === opts.maxRetries) break
            const delay = opts.baseMs * Math.pow(2, attempt)
            await new Promise((r) => setTimeout(r, delay))
        }
    }
    throw last
}

function buildSelectPageSql(
    job: TableSyncJob,
    batchSize: number,
    lastId: string | null,
    lastTs: string | null
): { sql: string; params: unknown[] } {
    const tableRef = quotePgIdent(job.externalTable)
    const cursorCol = quotePgIdent(job.cursorColumn)

    if (job.cursorKind === 'incremental_id') {
        const idParam = lastId ?? '0'
        const sql = `SELECT * FROM ${tableRef} WHERE ${cursorCol}::text > $1::text ORDER BY ${cursorCol} ASC LIMIT ${batchSize}`
        return { sql, params: [idParam] }
    }

    const tsParam = lastTs ?? '1970-01-01T00:00:00.000Z'
    const sql = `SELECT * FROM ${tableRef} WHERE ${cursorCol} > $1::timestamptz ORDER BY ${cursorCol} ASC LIMIT ${batchSize}`
    return { sql, params: [tsParam] }
}

/** MySQL variant (identifiers only; cursor comparison simplified) */
function buildSelectPageSqlMysql(
    job: TableSyncJob,
    batchSize: number,
    lastId: string | null,
    lastTs: string | null
): { sql: string; params: unknown[] } {
    const tableRef = job.externalTable
        .split('.')
        .map((p) => `\`${p.replace(/`/g, '')}\``)
        .join('.')
    const cursorCol = `\`${job.cursorColumn.replace(/`/g, '')}\``

    if (job.cursorKind === 'incremental_id') {
        const idParam = lastId ?? '0'
        return {
            sql: `SELECT * FROM ${tableRef} WHERE CAST(${cursorCol} AS CHAR) > ? ORDER BY ${cursorCol} ASC LIMIT ${batchSize}`,
            params: [idParam],
        }
    }
    const tsParam = lastTs ?? '1970-01-01 00:00:00'
    return {
        sql: `SELECT * FROM ${tableRef} WHERE ${cursorCol} > ? ORDER BY ${cursorCol} ASC LIMIT ${batchSize}`,
        params: [tsParam],
    }
}

async function loadMeta(
    rpc: DataSource['rpc'],
    localTable: string
): Promise<{
    last_cursor_id: string | null
    last_cursor_ts: string | null
}> {
    const rows = (await rpc.executeQuery({
        sql: `SELECT last_cursor_id, last_cursor_ts FROM ${META_TABLE} WHERE table_name = ?`,
        params: [localTable],
    })) as Record<string, unknown>[]
    const row = rows[0]
    return {
        last_cursor_id:
            row?.last_cursor_id != null ? String(row.last_cursor_id) : null,
        last_cursor_ts:
            row?.last_cursor_ts != null ? String(row.last_cursor_ts) : null,
    }
}

async function saveMeta(
    rpc: DataSource['rpc'],
    job: TableSyncJob,
    patch: {
        last_cursor_id?: string | null
        last_cursor_ts?: string | null
        sync_status: SyncStatusState
        error_message?: string | null
        rows_last_run: number
    }
): Promise<void> {
    await rpc.executeQuery({
        sql: `
        INSERT INTO ${META_TABLE} (table_name, last_synced_at, last_cursor_id, last_cursor_ts, sync_status, error_message, rows_last_run, updated_at)
        VALUES (?, datetime('now'), ?, ?, ?, ?, ?, datetime('now'))
        ON CONFLICT(table_name) DO UPDATE SET
            last_synced_at = excluded.last_synced_at,
            last_cursor_id = COALESCE(excluded.last_cursor_id, last_cursor_id),
            last_cursor_ts = COALESCE(excluded.last_cursor_ts, last_cursor_ts),
            sync_status = excluded.sync_status,
            error_message = excluded.error_message,
            rows_last_run = excluded.rows_last_run,
            updated_at = excluded.updated_at
        `,
        params: [
            job.localTable,
            patch.last_cursor_id ?? null,
            patch.last_cursor_ts ?? null,
            patch.sync_status,
            patch.error_message ?? null,
            patch.rows_last_run,
        ],
    })
}

function maxCursorFromRows(
    rows: Record<string, unknown>[],
    job: TableSyncJob
): { id: string | null; ts: string | null } {
    let maxId: string | null = null
    let maxTs: string | null = null
    const col = job.cursorColumn
    for (const r of rows) {
        const v = r[col]
        if (job.cursorKind === 'incremental_id') {
            const s = v != null ? String(v) : null
            if (!s) continue
            if (!maxId) {
                maxId = s
                continue
            }
            const bothNumeric = /^\d+$/.test(s) && /^\d+$/.test(maxId)
            if (bothNumeric) {
                if (BigInt(s) > BigInt(maxId)) maxId = s
            } else if (s > maxId) {
                maxId = s
            }
        } else {
            const iso =
                v instanceof Date
                    ? v.toISOString()
                    : v != null
                      ? String(v)
                      : null
            if (iso && (!maxTs || iso > maxTs)) maxTs = iso
        }
    }
    return { id: maxId, ts: maxTs }
}

export async function syncOneTable(opts: {
    job: TableSyncJob
    adapter: ExternalReadAdapter
    dataSource: DataSource
    pluginConfig: DataSyncPluginConfig
    isMysql: boolean
}): Promise<TableSyncResult> {
    const { job, adapter, dataSource, pluginConfig, isMysql } = opts
    const rpc = dataSource.rpc
    let totalFetched = 0
    let totalWritten = 0

    try {
        await saveMeta(rpc, job, {
            sync_status: 'running',
            error_message: null,
            rows_last_run: 0,
        })

        let { last_cursor_id, last_cursor_ts } = await loadMeta(
            rpc,
            job.localTable
        )
        let hasMore = true

        while (hasMore) {
            const { sql, params } = isMysql
                ? buildSelectPageSqlMysql(
                      job,
                      pluginConfig.batchSize,
                      last_cursor_id,
                      last_cursor_ts
                  )
                : buildSelectPageSql(
                      job,
                      pluginConfig.batchSize,
                      last_cursor_id,
                      last_cursor_ts
                  )

            const page = await withRetry(
                () => adapter.query<Record<string, unknown>>(sql, params),
                {
                    maxRetries: pluginConfig.maxRetries,
                    baseMs: pluginConfig.retryBaseMs,
                }
            )

            if (!page.length) {
                hasMore = false
                break
            }

            totalFetched += page.length
            const mapped = page.map((r) => buildRowForLocal(r, job))
            const upsert = buildBatchUpsert(job, mapped)
            if (upsert) {
                await rpc.executeQuery({
                    sql: upsert.sql,
                    params: upsert.params,
                })
                totalWritten += page.length
            }

            const { id, ts } = maxCursorFromRows(page, job)
            if (job.cursorKind === 'incremental_id' && id) {
                last_cursor_id = id
            }
            if (job.cursorKind === 'timestamp' && ts) {
                last_cursor_ts = ts
            }

            await saveMeta(rpc, job, {
                last_cursor_id:
                    job.cursorKind === 'incremental_id' ? last_cursor_id : null,
                last_cursor_ts:
                    job.cursorKind === 'timestamp' ? last_cursor_ts : null,
                sync_status: 'running',
                rows_last_run: totalWritten,
            })

            if (page.length < pluginConfig.batchSize) {
                hasMore = false
            }
        }

        await saveMeta(rpc, job, {
            last_cursor_id:
                job.cursorKind === 'incremental_id' ? last_cursor_id : null,
            last_cursor_ts:
                job.cursorKind === 'timestamp' ? last_cursor_ts : null,
            sync_status: 'ok',
            error_message: null,
            rows_last_run: totalWritten,
        })

        await appendLog(
            rpc,
            'info',
            job.localTable,
            `Synced ${totalWritten} rows (fetched ${totalFetched})`
        )

        return { job, rowsFetched: totalFetched, rowsWritten: totalWritten }
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        await saveMeta(rpc, job, {
            sync_status: 'error',
            error_message: msg,
            rows_last_run: totalWritten,
        })
        await appendLog(rpc, 'error', job.localTable, msg)
        return {
            job,
            rowsFetched: totalFetched,
            rowsWritten: totalWritten,
            error: msg,
        }
    }
}

export async function runFullSync(opts: {
    jobs: TableSyncJob[]
    adapter: ExternalReadAdapter | null
    dataSource: DataSource
    pluginConfig: DataSyncPluginConfig
    dialect: 'postgresql' | 'mysql' | 'none'
}): Promise<SyncRunSummary> {
    const startedAt = new Date().toISOString()
    const results: TableSyncResult[] = []

    if (!opts.adapter || opts.dialect === 'none') {
        return {
            startedAt,
            finishedAt: new Date().toISOString(),
            results: [],
            overallStatus: 'error',
        }
    }

    const isMysql = opts.dialect === 'mysql'

    await ensureDataSyncTables(opts.dataSource.rpc)

    for (const job of opts.jobs) {
        assertSqliteIdent(job.localTable, 'table name')
        const r = await syncOneTable({
            job,
            adapter: opts.adapter,
            dataSource: opts.dataSource,
            pluginConfig: opts.pluginConfig,
            isMysql,
        })
        results.push(r)
    }

    const finishedAt = new Date().toISOString()
    const hasErr = results.some((x) => x.error)
    const partial = hasErr && results.some((x) => !x.error)
    const overallStatus: SyncStatusState = hasErr
        ? partial
            ? 'partial'
            : 'error'
        : 'ok'

    return { startedAt, finishedAt, results, overallStatus }
}
