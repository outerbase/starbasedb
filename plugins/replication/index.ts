import { executeQuery } from '../../src/operation'
import { StarbaseApp, StarbaseDBConfiguration } from '../../src/handler'
import { StarbasePlugin } from '../../src/plugin'
import { DataSource } from '../../src/types'
import { createResponse } from '../../src/utils'

type ReplicationTask = {
    id: string
    source_table: string
    target_table: string
    cursor_column: string
    cursor_value: string | null
    interval_seconds: number
    batch_size: number
    next_run_at: number
    is_active: number
    callback_host: string | null
    last_error: string | null
    created_at: number
    updated_at: number
}

const SQL_QUERIES = {
    CREATE_TABLE: `
        CREATE TABLE IF NOT EXISTS tmp_replication_tasks (
            id TEXT PRIMARY KEY,
            source_table TEXT NOT NULL,
            target_table TEXT NOT NULL,
            cursor_column TEXT NOT NULL,
            cursor_value TEXT,
            interval_seconds INTEGER NOT NULL DEFAULT 60,
            batch_size INTEGER NOT NULL DEFAULT 500,
            next_run_at INTEGER NOT NULL,
            is_active INTEGER NOT NULL DEFAULT 1,
            callback_host TEXT,
            last_error TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        )
    `,
    INSERT_TASK: `
        INSERT INTO tmp_replication_tasks (
            id,
            source_table,
            target_table,
            cursor_column,
            cursor_value,
            interval_seconds,
            batch_size,
            next_run_at,
            is_active,
            callback_host,
            last_error,
            created_at,
            updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    GET_TASKS: `
        SELECT *
        FROM tmp_replication_tasks
        ORDER BY updated_at DESC
    `,
    GET_TASK: `
        SELECT *
        FROM tmp_replication_tasks
        WHERE id = ?
        LIMIT 1
    `,
    GET_DUE_TASKS: `
        SELECT *
        FROM tmp_replication_tasks
        WHERE is_active = 1 AND next_run_at <= ?
        ORDER BY next_run_at ASC
        LIMIT ?
    `,
    UPDATE_TASK_SYNC_STATE: `
        UPDATE tmp_replication_tasks
        SET cursor_value = ?,
            next_run_at = ?,
            updated_at = ?,
            last_error = NULL
        WHERE id = ?
    `,
    UPDATE_TASK_ERROR: `
        UPDATE tmp_replication_tasks
        SET next_run_at = ?,
            updated_at = ?,
            last_error = ?
        WHERE id = ?
    `,
    DELETE_TASK: `
        DELETE FROM tmp_replication_tasks
        WHERE id = ?
    `,
}

export class ReplicationPlugin extends StarbasePlugin {
    public pathPrefix: string = '/replication'

    private dataSource?: DataSource
    private config?: StarbaseDBConfiguration

    constructor() {
        super('starbasedb:replication', {
            requiresAuth: true,
        })
    }

    override async register(app: StarbaseApp) {
        app.use(async (c, next) => {
            this.dataSource = c.get('dataSource')
            this.config = c.get('config')
            await this.init()
            await this.scheduleNextAlarm()
            await next()
        })

        app.post(`${this.pathPrefix}/tasks`, async (c) => {
            if (this.config?.role !== 'admin') {
                return createResponse(undefined, 'Unauthorized request', 400)
            }

            if (!this.dataSource?.external) {
                return createResponse(
                    undefined,
                    'External data source is required for replication.',
                    400
                )
            }

            const body = await c.req.json()
            const validated = this.validateTaskInput(body)

            if (!validated.valid) {
                return createResponse(undefined, validated.message, 400)
            }

            const now = Date.now()
            const id = crypto.randomUUID()
            const callbackHost = new URL(c.req.raw.url).origin

            await this.dataSource.rpc.executeQuery({
                sql: SQL_QUERIES.INSERT_TASK,
                params: [
                    id,
                    validated.sourceTable,
                    validated.targetTable,
                    validated.cursorColumn,
                    null,
                    validated.intervalSeconds,
                    validated.batchSize,
                    now,
                    1,
                    callbackHost,
                    null,
                    now,
                    now,
                ],
            })

            await this.scheduleNextAlarm()

            return createResponse(
                {
                    id,
                    sourceTable: validated.sourceTable,
                    targetTable: validated.targetTable,
                    cursorColumn: validated.cursorColumn,
                    intervalSeconds: validated.intervalSeconds,
                    batchSize: validated.batchSize,
                },
                undefined,
                201
            )
        })

        app.get(`${this.pathPrefix}/tasks`, async () => {
            if (this.config?.role !== 'admin') {
                return createResponse(undefined, 'Unauthorized request', 400)
            }

            const rows = (await this.dataSource?.rpc.executeQuery({
                sql: SQL_QUERIES.GET_TASKS,
                params: [],
            })) as unknown as ReplicationTask[]

            const tasks = (rows || []).map((row) => ({
                id: row.id,
                sourceTable: row.source_table,
                targetTable: row.target_table,
                cursorColumn: row.cursor_column,
                cursorValue: this.deserializeCursor(row.cursor_value),
                intervalSeconds: Number(row.interval_seconds),
                batchSize: Number(row.batch_size),
                nextRunAt: Number(row.next_run_at),
                isActive: Number(row.is_active) === 1,
                lastError: row.last_error,
                updatedAt: Number(row.updated_at),
            }))

            return createResponse({ tasks }, undefined, 200)
        })

        app.delete(`${this.pathPrefix}/tasks/:taskId`, async (c) => {
            if (this.config?.role !== 'admin') {
                return createResponse(undefined, 'Unauthorized request', 400)
            }

            const taskId = c.req.param('taskId')
            await this.dataSource?.rpc.executeQuery({
                sql: SQL_QUERIES.DELETE_TASK,
                params: [taskId],
            })

            await this.scheduleNextAlarm()
            return createResponse({ deleted: true, taskId }, undefined, 200)
        })

        app.post(`${this.pathPrefix}/tasks/:taskId/run`, async (c) => {
            if (this.config?.role !== 'admin') {
                return createResponse(undefined, 'Unauthorized request', 400)
            }

            const taskId = c.req.param('taskId')
            const result = await this.runTask(taskId)

            if (!result.success) {
                return createResponse(undefined, result.message, 500)
            }

            await this.scheduleNextAlarm()
            return createResponse(result, undefined, 200)
        })

        app.post(`${this.pathPrefix}/callback`, async (c) => {
            const taskId = c.req.query('taskId')
            const now = Date.now()

            if (taskId) {
                const result = await this.runTask(taskId)
                await this.scheduleNextAlarm()
                return createResponse(
                    result,
                    undefined,
                    result.success ? 200 : 500
                )
            }

            const dueTasks = (await this.dataSource?.rpc.executeQuery({
                sql: SQL_QUERIES.GET_DUE_TASKS,
                params: [now, 3],
            })) as unknown as ReplicationTask[]

            const results: Array<{
                taskId: string
                success: boolean
                rowsSynced: number
                message?: string
            }> = []
            for (const dueTask of dueTasks || []) {
                const result = await this.runTask(dueTask.id)
                results.push({
                    taskId: dueTask.id,
                    success: result.success,
                    rowsSynced: result.rowsSynced,
                    message: result.message,
                })
            }

            await this.scheduleNextAlarm()
            return createResponse({ results }, undefined, 200)
        })
    }

    private async init() {
        if (!this.dataSource) return

        await this.dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.CREATE_TABLE,
            params: [],
        })
    }

    private validateIdentifier(input: unknown): input is string {
        return (
            typeof input === 'string' &&
            /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(input.trim())
        )
    }

    private validateTaskInput(body: any):
        | {
              valid: true
              sourceTable: string
              targetTable: string
              cursorColumn: string
              intervalSeconds: number
              batchSize: number
          }
        | { valid: false; message: string } {
        if (!body || typeof body !== 'object') {
            return { valid: false, message: 'Request body is required.' }
        }

        const sourceTable = body.sourceTable
        const targetTable = body.targetTable || sourceTable
        const cursorColumn = body.cursorColumn

        if (!this.validateIdentifier(sourceTable)) {
            return {
                valid: false,
                message: 'sourceTable must be a valid identifier.',
            }
        }

        if (!this.validateIdentifier(targetTable)) {
            return {
                valid: false,
                message: 'targetTable must be a valid identifier.',
            }
        }

        if (!this.validateIdentifier(cursorColumn)) {
            return {
                valid: false,
                message: 'cursorColumn must be a valid identifier.',
            }
        }

        const intervalSeconds = Number(body.intervalSeconds ?? 60)
        const batchSize = Number(body.batchSize ?? 500)

        if (!Number.isFinite(intervalSeconds) || intervalSeconds < 10) {
            return {
                valid: false,
                message: 'intervalSeconds must be at least 10.',
            }
        }

        if (!Number.isFinite(batchSize) || batchSize < 1 || batchSize > 5000) {
            return {
                valid: false,
                message: 'batchSize must be between 1 and 5000.',
            }
        }

        return {
            valid: true,
            sourceTable: sourceTable.trim(),
            targetTable: targetTable.trim(),
            cursorColumn: cursorColumn.trim(),
            intervalSeconds,
            batchSize,
        }
    }

    private serializeCursor(value: unknown): string {
        return JSON.stringify(value)
    }

    private deserializeCursor(value: string | null): unknown {
        if (!value) {
            return undefined
        }

        try {
            return JSON.parse(value)
        } catch {
            return value
        }
    }

    private async loadTask(taskId: string): Promise<ReplicationTask | null> {
        const rows = (await this.dataSource?.rpc.executeQuery({
            sql: SQL_QUERIES.GET_TASK,
            params: [taskId],
        })) as unknown as ReplicationTask[]

        return rows?.length ? rows[0] : null
    }

    private async runTask(taskId: string): Promise<{
        success: boolean
        rowsSynced: number
        message?: string
    }> {
        if (!this.dataSource || !this.config) {
            return {
                success: false,
                rowsSynced: 0,
                message: 'Replication plugin is not initialized.',
            }
        }

        if (!this.dataSource.external) {
            return {
                success: false,
                rowsSynced: 0,
                message: 'External data source is required for replication.',
            }
        }

        const task = await this.loadTask(taskId)

        if (!task) {
            return {
                success: false,
                rowsSynced: 0,
                message: 'Replication task not found.',
            }
        }

        const now = Date.now()

        try {
            const externalDataSource: DataSource = {
                ...this.dataSource,
                source: 'external',
                cache: false,
            }

            const cursorValue = this.deserializeCursor(task.cursor_value)
            const hasCursor = cursorValue !== undefined && cursorValue !== null
            const selectSQL = hasCursor
                ? `SELECT * FROM ${task.source_table} WHERE ${task.cursor_column} > ? ORDER BY ${task.cursor_column} ASC LIMIT ?`
                : `SELECT * FROM ${task.source_table} ORDER BY ${task.cursor_column} ASC LIMIT ?`
            const selectParams = hasCursor
                ? [cursorValue, Number(task.batch_size)]
                : [Number(task.batch_size)]

            const rows = (await executeQuery({
                sql: selectSQL,
                params: selectParams,
                isRaw: false,
                dataSource: externalDataSource,
                config: this.config,
            })) as Array<Record<string, unknown>>

            if (!rows.length) {
                await this.dataSource.rpc.executeQuery({
                    sql: SQL_QUERIES.UPDATE_TASK_SYNC_STATE,
                    params: [
                        task.cursor_value,
                        now + Number(task.interval_seconds) * 1000,
                        now,
                        task.id,
                    ],
                })

                return {
                    success: true,
                    rowsSynced: 0,
                }
            }

            for (const row of rows) {
                const columns = Object.keys(row)
                const placeholders = columns.map(() => '?').join(', ')
                const values = columns.map((col) => {
                    const value = row[col]
                    return value === undefined ? null : value
                })
                const sql = `INSERT OR REPLACE INTO ${task.target_table} (${columns.join(', ')}) VALUES (${placeholders})`

                await this.dataSource.rpc.executeQuery({
                    sql,
                    params: values,
                })
            }

            const lastRow = rows[rows.length - 1]
            const nextCursor = this.serializeCursor(lastRow[task.cursor_column])
            const nextRunAt =
                rows.length >= Number(task.batch_size)
                    ? now + 1000
                    : now + Number(task.interval_seconds) * 1000

            await this.dataSource.rpc.executeQuery({
                sql: SQL_QUERIES.UPDATE_TASK_SYNC_STATE,
                params: [nextCursor, nextRunAt, now, task.id],
            })

            return {
                success: true,
                rowsSynced: rows.length,
            }
        } catch (error: any) {
            const retryAt = now + Number(task.interval_seconds) * 1000
            await this.dataSource.rpc.executeQuery({
                sql: SQL_QUERIES.UPDATE_TASK_ERROR,
                params: [
                    retryAt,
                    now,
                    error?.message || 'Replication task failed.',
                    task.id,
                ],
            })

            return {
                success: false,
                rowsSynced: 0,
                message: error?.message || 'Replication task failed.',
            }
        }
    }

    private async scheduleNextAlarm() {
        if (!this.dataSource) {
            return
        }

        const rows = (await this.dataSource.rpc.executeQuery({
            sql: `SELECT MIN(next_run_at) AS next_run_at
                  FROM tmp_replication_tasks
                  WHERE is_active = 1;`,
            params: [],
        })) as unknown as Array<{ next_run_at: number | null }>

        const nextRun = Number(rows?.[0]?.next_run_at || 0)
        if (nextRun > 0) {
            await this.dataSource.rpc.setAlarm(nextRun)
        }
    }
}
