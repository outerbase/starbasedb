import type { StarbaseDBConfiguration } from '../../src/handler'
import { executeExternalQuery, executeTransaction } from '../../src/operation'
import type { DataSource } from '../../src/types'
import type { ExternalDialect } from './utils'
import {
    clampBatchSize,
    inferSQLiteType,
    parseCursorValue,
    quoteIdentifier,
    serializeCursorValue,
    toSqliteValue,
    validateIdentifier,
} from './utils'

export type SyncTaskConfig = {
    name: string
    sourceTable: string
    targetTable: string
    cursorColumn: string
    sourceSchema?: string
    intervalCron: string
    batchSize?: number
}

const SQL = {
    CREATE_SYNC_TABLES: [
        `
        CREATE TABLE IF NOT EXISTS tmp_data_sync_tasks (
            name TEXT PRIMARY KEY,
            source_table TEXT NOT NULL,
            source_schema TEXT,
            target_table TEXT NOT NULL,
            cursor_column TEXT NOT NULL,
            cron_tab TEXT NOT NULL,
            batch_size INTEGER NOT NULL,
            last_cursor_value TEXT,
            last_synced_at INTEGER,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );
        `,
        `
        CREATE TABLE IF NOT EXISTS tmp_data_sync_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_name TEXT NOT NULL,
            status TEXT NOT NULL,
            synced_rows INTEGER NOT NULL,
            cursor_value TEXT,
            error_message TEXT,
            started_at INTEGER NOT NULL,
            finished_at INTEGER
        );
        `,
    ],
    UPSERT_TASK: `
        INSERT INTO tmp_data_sync_tasks (
            name,
            source_table,
            source_schema,
            target_table,
            cursor_column,
            cron_tab,
            batch_size,
            created_at,
            updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET
            source_table = excluded.source_table,
            source_schema = excluded.source_schema,
            target_table = excluded.target_table,
            cursor_column = excluded.cursor_column,
            cron_tab = excluded.cron_tab,
            batch_size = excluded.batch_size,
            updated_at = excluded.updated_at;
    `,
    LIST_TASKS: `
        SELECT
            name,
            source_table,
            source_schema,
            target_table,
            cursor_column,
            cron_tab,
            batch_size,
            last_cursor_value,
            last_synced_at
        FROM tmp_data_sync_tasks
        ORDER BY name ASC;
    `,
    GET_TASK: `
        SELECT
            name,
            source_table,
            source_schema,
            target_table,
            cursor_column,
            cron_tab,
            batch_size,
            last_cursor_value,
            last_synced_at
        FROM tmp_data_sync_tasks
        WHERE name = ?
        LIMIT 1;
    `,
    DELETE_TASK: `DELETE FROM tmp_data_sync_tasks WHERE name = ?;`,
    INSERT_RUN: `
        INSERT INTO tmp_data_sync_runs (task_name, status, synced_rows, started_at)
        VALUES (?, ?, 0, ?);
    `,
    UPDATE_RUN_SUCCESS: `
        UPDATE tmp_data_sync_runs
        SET status = 'success',
            synced_rows = ?,
            cursor_value = ?,
            finished_at = ?
        WHERE id = ?;
    `,
    UPDATE_RUN_FAILED: `
        UPDATE tmp_data_sync_runs
        SET status = 'failed',
            error_message = ?,
            finished_at = ?
        WHERE id = ?;
    `,
    UPDATE_CURSOR: `
        UPDATE tmp_data_sync_tasks
        SET last_cursor_value = ?,
            last_synced_at = ?,
            updated_at = ?
        WHERE name = ?;
    `,
}

type StoredTask = {
    name: string
    source_table: string
    source_schema: string | null
    target_table: string
    cursor_column: string
    cron_tab: string
    batch_size: number
    last_cursor_value: string | null
    last_synced_at: number | null
}

type NormalizedTask = {
    name: string
    sourceTable: string
    sourceSchema: string | null
    targetTable: string
    cursorColumn: string
    cronTab: string
    batchSize: number
    lastCursorRaw: string | null
    lastCursor: unknown
    lastSyncedAt: number | null
}

export type SyncRunSummary = {
    taskName: string
    syncedRows: number
    lastCursor: unknown
    sourceTable: string
    targetTable: string
    cursorColumn: string
}

const INTERNAL_SYSTEM_CONFIG: StarbaseDBConfiguration = {
    role: 'admin',
    features: {
        allowlist: false,
        rls: false,
        rest: false,
        websocket: false,
        export: false,
        import: false,
    },
}

function getExternalDialect(dataSource: DataSource): ExternalDialect {
    const dialect = dataSource.external?.dialect

    if (dialect === 'postgresql' || dialect === 'mysql' || dialect === 'sqlite') {
        return dialect
    }

    throw new Error('Data Sync requires an external SQL data source (postgresql/mysql/sqlite)')
}

function normalizeTask(task: StoredTask): NormalizedTask {
    return {
        name: task.name,
        sourceTable: task.source_table,
        sourceSchema: task.source_schema,
        targetTable: task.target_table,
        cursorColumn: task.cursor_column,
        cronTab: task.cron_tab,
        batchSize: Number(task.batch_size),
        lastCursorRaw: task.last_cursor_value,
        lastCursor: parseCursorValue(task.last_cursor_value),
        lastSyncedAt: task.last_synced_at === null ? null : Number(task.last_synced_at),
    }
}

async function runInternal(
    dataSource: DataSource,
    query: { sql: string; params?: unknown[] }
): Promise<any[]> {
    const result = await executeTransaction({
        queries: [query],
        isRaw: false,
        dataSource,
        config: INTERNAL_SYSTEM_CONFIG,
    })

    const rows = result[0]
    return Array.isArray(rows) ? rows : []
}

function buildExternalSelect(task: NormalizedTask, dialect: ExternalDialect): {
    sql: string
    params: unknown[]
} {
    const sourceTable = quoteIdentifier(task.sourceTable, dialect)
    const cursorColumn = quoteIdentifier(task.cursorColumn, dialect)
    const schemaPrefix = task.sourceSchema
        ? `${quoteIdentifier(task.sourceSchema, dialect)}.`
        : ''

    if (task.lastCursor === null || task.lastCursor === undefined) {
        return {
            sql: `SELECT * FROM ${schemaPrefix}${sourceTable} ORDER BY ${cursorColumn} ASC LIMIT ?;`,
            params: [task.batchSize],
        }
    }

    return {
        sql: `SELECT * FROM ${schemaPrefix}${sourceTable} WHERE ${cursorColumn} > ? ORDER BY ${cursorColumn} ASC LIMIT ?;`,
        params: [task.lastCursor, task.batchSize],
    }
}

async function ensureTargetTable(
    rows: Record<string, unknown>[],
    task: NormalizedTask,
    dataSource: DataSource
): Promise<void> {
    if (rows.length === 0) {
        return
    }

    const targetTable = validateIdentifier(task.targetTable, 'target table')
    const cursorColumn = validateIdentifier(task.cursorColumn, 'cursor column')

    const sample = rows[0]
    const sourceColumns = Object.keys(sample).map((column) =>
        validateIdentifier(column, 'column name')
    )

    if (sourceColumns.length === 0) {
        throw new Error(`Cannot infer schema for target table ${targetTable}`)
    }

    const existsRows = await runInternal(dataSource, {
        sql: `SELECT name FROM sqlite_master WHERE type='table' AND name=? LIMIT 1;`,
        params: [targetTable],
    })

    if (existsRows.length === 0) {
        const columnSql = sourceColumns
            .map((column) => `"${column}" ${inferSQLiteType(sample[column])}`)
            .join(', ')

        await runInternal(dataSource, {
            sql: `CREATE TABLE IF NOT EXISTS "${targetTable}" (${columnSql});`,
        })
    }

    const existingColumnsRows = await runInternal(dataSource, {
        sql: `PRAGMA table_info("${targetTable}");`,
    })

    const existingColumns = new Set(
        existingColumnsRows
            .map((row) => row?.name)
            .filter((value): value is string => typeof value === 'string')
    )

    for (const sourceColumn of sourceColumns) {
        if (existingColumns.has(sourceColumn)) {
            continue
        }

        await runInternal(dataSource, {
            sql: `ALTER TABLE "${targetTable}" ADD COLUMN "${sourceColumn}" ${inferSQLiteType(
                sample[sourceColumn]
            )};`,
        })
    }

    if (!sourceColumns.includes(cursorColumn) && !existingColumns.has(cursorColumn)) {
        throw new Error(
            `Cursor column ${cursorColumn} does not exist in source row or target table ${targetTable}`
        )
    }

    const uniqueIndexName = `tmp_data_sync_${targetTable}_${cursorColumn}_uniq_idx`
    await runInternal(dataSource, {
        sql: `CREATE UNIQUE INDEX IF NOT EXISTS "${uniqueIndexName}" ON "${targetTable}" ("${cursorColumn}");`,
    })
}

async function upsertRows(
    rows: Record<string, unknown>[],
    task: NormalizedTask,
    dataSource: DataSource
): Promise<number> {
    if (rows.length === 0) {
        return 0
    }

    await ensureTargetTable(rows, task, dataSource)

    const targetTable = validateIdentifier(task.targetTable, 'target table')
    const cursorColumn = validateIdentifier(task.cursorColumn, 'cursor column')

    let syncedRows = 0

    for (const row of rows) {
        const columns = Object.keys(row).map((column) =>
            validateIdentifier(column, 'column name')
        )

        if (columns.length === 0) {
            continue
        }

        const columnList = columns.map((column) => `"${column}"`).join(', ')
        const placeholders = columns.map(() => '?').join(', ')
        const params = columns.map((column) => toSqliteValue(row[column]))

        const updateColumns = columns.filter((column) => column !== cursorColumn)
        const updateSql = updateColumns
            .map((column) => `"${column}"=excluded."${column}"`)
            .join(', ')

        const sql = updateColumns.length
            ? `INSERT INTO "${targetTable}" (${columnList}) VALUES (${placeholders}) ON CONFLICT("${cursorColumn}") DO UPDATE SET ${updateSql};`
            : `INSERT OR IGNORE INTO "${targetTable}" (${columnList}) VALUES (${placeholders});`

        await runInternal(dataSource, { sql, params })
        syncedRows += 1
    }

    return syncedRows
}

export async function ensureDataSyncTables(dataSource: DataSource): Promise<void> {
    for (const sql of SQL.CREATE_SYNC_TABLES) {
        await runInternal(dataSource, { sql })
    }
}

export async function upsertDataSyncTask(
    dataSource: DataSource,
    input: SyncTaskConfig
): Promise<{ name: string; cronTab: string; batchSize: number }> {
    const now = Date.now()

    const name = validateIdentifier(input.name, 'task name')
    const sourceTable = validateIdentifier(input.sourceTable, 'source table')
    const targetTable = validateIdentifier(input.targetTable, 'target table')
    const cursorColumn = validateIdentifier(input.cursorColumn, 'cursor column')
    const sourceSchema = input.sourceSchema
        ? validateIdentifier(input.sourceSchema, 'source schema')
        : null

    if (!input.intervalCron?.trim()) {
        throw new Error('intervalCron is required')
    }

    const batchSize = clampBatchSize(input.batchSize)

    await runInternal(dataSource, {
        sql: SQL.UPSERT_TASK,
        params: [
            name,
            sourceTable,
            sourceSchema,
            targetTable,
            cursorColumn,
            input.intervalCron.trim(),
            batchSize,
            now,
            now,
        ],
    })

    return {
        name,
        cronTab: input.intervalCron.trim(),
        batchSize,
    }
}

export async function listDataSyncTasks(dataSource: DataSource): Promise<any[]> {
    const rows = await runInternal(dataSource, { sql: SQL.LIST_TASKS })

    return rows.map((row) => {
        const normalized = normalizeTask(row as StoredTask)
        return {
            name: normalized.name,
            sourceTable: normalized.sourceTable,
            sourceSchema: normalized.sourceSchema,
            targetTable: normalized.targetTable,
            cursorColumn: normalized.cursorColumn,
            cronTab: normalized.cronTab,
            batchSize: normalized.batchSize,
            lastCursor: normalized.lastCursor,
            lastSyncedAt: normalized.lastSyncedAt,
        }
    })
}

export async function deleteDataSyncTask(
    dataSource: DataSource,
    name: string
): Promise<boolean> {
    const safeName = validateIdentifier(name, 'task name')
    const before = await runInternal(dataSource, {
        sql: 'SELECT name FROM tmp_data_sync_tasks WHERE name = ? LIMIT 1;',
        params: [safeName],
    })

    if (before.length === 0) {
        return false
    }

    await runInternal(dataSource, {
        sql: SQL.DELETE_TASK,
        params: [safeName],
    })

    return true
}

export async function runDataSyncTask(
    dataSource: DataSource,
    taskName: string,
    config: StarbaseDBConfiguration
): Promise<SyncRunSummary> {
    const safeTaskName = validateIdentifier(taskName, 'task name')

    await ensureDataSyncTables(dataSource)

    const taskRows = await runInternal(dataSource, {
        sql: SQL.GET_TASK,
        params: [safeTaskName],
    })

    if (taskRows.length === 0) {
        throw new Error(`Sync task not found: ${safeTaskName}`)
    }

    if (!dataSource.external) {
        throw new Error('Data Sync task requires external data source configuration')
    }

    const task = normalizeTask(taskRows[0] as StoredTask)
    const dialect = getExternalDialect(dataSource)

    const startedAt = Date.now()

    await runInternal(dataSource, {
        sql: SQL.INSERT_RUN,
        params: [task.name, 'running', startedAt],
    })

    const runIdRows = await runInternal(dataSource, {
        sql: 'SELECT last_insert_rowid() AS id;',
    })
    const runId = Number(runIdRows[0]?.id || 0)

    try {
        const externalSelect = buildExternalSelect(task, dialect)
        const externalRows = (await executeExternalQuery({
            sql: externalSelect.sql,
            params: externalSelect.params,
            dataSource,
            config,
        })) as Record<string, unknown>[]

        if (!Array.isArray(externalRows)) {
            throw new Error('External data sync query returned non-array result')
        }

        const syncedRows = await upsertRows(externalRows, task, dataSource)
        const lastRow =
            externalRows.length > 0 ? externalRows[externalRows.length - 1] : null
        const newCursor = lastRow ? lastRow[task.cursorColumn] : task.lastCursor
        const cursorRaw =
            newCursor === null || newCursor === undefined
                ? task.lastCursorRaw
                : serializeCursorValue(newCursor)

        await runInternal(dataSource, {
            sql: SQL.UPDATE_CURSOR,
            params: [cursorRaw, Date.now(), Date.now(), task.name],
        })

        await runInternal(dataSource, {
            sql: SQL.UPDATE_RUN_SUCCESS,
            params: [syncedRows, cursorRaw, Date.now(), runId],
        })

        return {
            taskName: task.name,
            syncedRows,
            lastCursor: newCursor,
            sourceTable: task.sourceTable,
            targetTable: task.targetTable,
            cursorColumn: task.cursorColumn,
        }
    } catch (error: any) {
        await runInternal(dataSource, {
            sql: SQL.UPDATE_RUN_FAILED,
            params: [error?.message || 'Data sync failed', Date.now(), runId],
        })

        throw error
    }
}
