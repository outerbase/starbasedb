import { StarbaseApp, StarbaseDBConfiguration } from '../../src/handler'
import { StarbasePlugin } from '../../src/plugin'
import { DataSource, QueryResult } from '../../src/types'
import { createResponse } from '../../src/utils'
import { executeExternalQuery } from '../../src/operation'

interface ReplicationTableConfig {
    name: string
    cursorColumn: string
    interval: number // seconds
}

interface ReplicationState {
    tableName: string
    lastCursor: string | null
    lastSyncAt: string | null
    rowCount: number
}

const SQL_QUERIES = {
    CREATE_CONFIG_TABLE: `
        CREATE TABLE IF NOT EXISTS tmp_replication_config (
            "table_name" TEXT NOT NULL PRIMARY KEY,
            "cursor_column" TEXT NOT NULL,
            "interval" INTEGER NOT NULL DEFAULT 60,
            "created_at" TEXT DEFAULT (datetime('now')),
            "updated_at" TEXT DEFAULT (datetime('now'))
        )
    `,
    CREATE_STATE_TABLE: `
        CREATE TABLE IF NOT EXISTS tmp_replication_state (
            "table_name" TEXT NOT NULL PRIMARY KEY,
            "last_cursor" TEXT,
            "last_sync_at" TEXT,
            "row_count" INTEGER NOT NULL DEFAULT 0
        )
    `,
    UPSERT_CONFIG: `
        INSERT INTO tmp_replication_config (table_name, cursor_column, interval, updated_at)
        VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT(table_name) DO UPDATE SET
            cursor_column = excluded.cursor_column,
            interval = excluded.interval,
            updated_at = excluded.updated_at
    `,
    GET_ALL_CONFIGS: `
        SELECT c.table_name, c.cursor_column, c.interval,
               s.last_cursor, s.last_sync_at, s.row_count
        FROM tmp_replication_config c
        LEFT JOIN tmp_replication_state s ON c.table_name = s.table_name
    `,
    GET_CONFIG: `
        SELECT table_name, cursor_column, interval
        FROM tmp_replication_config
        WHERE table_name = ?
    `,
    DELETE_CONFIG: `
        DELETE FROM tmp_replication_config WHERE table_name = ?
    `,
    DELETE_STATE: `
        DELETE FROM tmp_replication_state WHERE table_name = ?
    `,
    UPSERT_STATE: `
        INSERT INTO tmp_replication_state (table_name, last_cursor, last_sync_at, row_count)
        VALUES (?, ?, datetime('now'), ?)
        ON CONFLICT(table_name) DO UPDATE SET
            last_cursor = excluded.last_cursor,
            last_sync_at = excluded.last_sync_at,
            row_count = tmp_replication_state.row_count + excluded.row_count
    `,
    GET_STATE: `
        SELECT last_cursor, last_sync_at, row_count
        FROM tmp_replication_state
        WHERE table_name = ?
    `,
}

const BATCH_SIZE = 1000

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
            this.dataSource = c?.get('dataSource')
            this.config = c?.get('config')
            await this.init()
            await next()
        })

        // POST /replication/tables — configure tables to replicate
        app.post(`${this.pathPrefix}/tables`, async (c) => {
            if (this.config?.role !== 'admin') {
                return createResponse(undefined, 'Unauthorized request', 401)
            }

            let body: { tables: ReplicationTableConfig[] }

            try {
                body = await c.req.json()
            } catch {
                return createResponse(undefined, 'Invalid JSON body', 400)
            }

            if (!Array.isArray(body?.tables) || body.tables.length === 0) {
                return createResponse(
                    undefined,
                    'Body must contain a non-empty "tables" array',
                    400
                )
            }

            for (const table of body.tables) {
                if (!table.name || typeof table.name !== 'string') {
                    return createResponse(
                        undefined,
                        'Each table entry must have a "name" field',
                        400
                    )
                }

                if (
                    !table.cursorColumn ||
                    typeof table.cursorColumn !== 'string'
                ) {
                    return createResponse(
                        undefined,
                        'Each table entry must have a "cursorColumn" field',
                        400
                    )
                }

                const interval =
                    typeof table.interval === 'number' && table.interval > 0
                        ? table.interval
                        : 60

                await this.dataSource!.rpc.executeQuery({
                    sql: SQL_QUERIES.UPSERT_CONFIG,
                    params: [table.name, table.cursorColumn, interval],
                })
            }

            await this.scheduleNextAlarm()

            return createResponse(
                { success: true, count: body.tables.length },
                undefined,
                200
            )
        })

        // GET /replication/status — show sync status per table
        app.get(`${this.pathPrefix}/status`, async (c) => {
            if (this.config?.role !== 'admin') {
                return createResponse(undefined, 'Unauthorized request', 401)
            }

            const rows = (await this.dataSource!.rpc.executeQuery({
                sql: SQL_QUERIES.GET_ALL_CONFIGS,
                params: [],
            })) as QueryResult[]

            return createResponse(rows, undefined, 200)
        })

        // POST /replication/sync — trigger manual sync
        app.post(`${this.pathPrefix}/sync`, async (c) => {
            if (this.config?.role !== 'admin') {
                return createResponse(undefined, 'Unauthorized request', 401)
            }

            if (!this.dataSource?.external) {
                return createResponse(
                    undefined,
                    'No external data source configured',
                    400
                )
            }

            const results = await this.syncAllTables()

            return createResponse({ success: true, results }, undefined, 200)
        })

        // DELETE /replication/tables/:name — remove a table from replication
        app.delete(`${this.pathPrefix}/tables/:name`, async (c) => {
            if (this.config?.role !== 'admin') {
                return createResponse(undefined, 'Unauthorized request', 401)
            }

            const tableName = c.req.param('name')

            if (!tableName) {
                return createResponse(
                    undefined,
                    'Table name parameter is required',
                    400
                )
            }

            await this.dataSource!.rpc.executeQuery({
                sql: SQL_QUERIES.DELETE_CONFIG,
                params: [tableName],
            })

            await this.dataSource!.rpc.executeQuery({
                sql: SQL_QUERIES.DELETE_STATE,
                params: [tableName],
            })

            return createResponse({ success: true }, undefined, 200)
        })
    }

    private async init() {
        if (!this.dataSource) return

        await this.dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.CREATE_CONFIG_TABLE,
            params: [],
        })

        await this.dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.CREATE_STATE_TABLE,
            params: [],
        })
    }

    private async scheduleNextAlarm() {
        if (!this.dataSource) return

        const rows = (await this.dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.GET_ALL_CONFIGS,
            params: [],
        })) as QueryResult[]

        if (rows.length === 0) {
            return
        }

        // Use the shortest interval across all configured tables so we never
        // miss a sync window. Each table checks its own interval at sync time.
        const minIntervalSeconds = rows.reduce((min, row) => {
            const interval = Number(row.interval)
            return interval < min ? interval : min
        }, Infinity)

        if (minIntervalSeconds !== Infinity) {
            await this.dataSource.rpc.setAlarm(
                Date.now() + minIntervalSeconds * 1000
            )
        }
    }

    /**
     * Called by the DO alarm handler. Syncs all tables that are due and
     * reschedules the next alarm.
     */
    public async onAlarm() {
        if (!this.dataSource) return

        if (!this.dataSource.external) {
            console.warn(
                'ReplicationPlugin: alarm fired but no external source configured'
            )
            return
        }

        await this.syncAllTables()
        await this.scheduleNextAlarm()
    }

    private async syncAllTables(): Promise<
        { table: string; inserted: number; error?: string }[]
    > {
        if (!this.dataSource) return []

        const rows = (await this.dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.GET_ALL_CONFIGS,
            params: [],
        })) as QueryResult[]

        const results: { table: string; inserted: number; error?: string }[] =
            []

        for (const row of rows) {
            const tableName = String(row.table_name)
            const cursorColumn = String(row.cursor_column)
            const lastCursor = row.last_cursor ?? null

            try {
                const inserted = await this.syncTable(
                    tableName,
                    cursorColumn,
                    lastCursor as string | null
                )
                results.push({ table: tableName, inserted })
            } catch (err: any) {
                console.error(
                    `ReplicationPlugin: error syncing table "${tableName}":`,
                    err
                )
                results.push({
                    table: tableName,
                    inserted: 0,
                    error: err?.message ?? 'Unknown error',
                })
            }
        }

        return results
    }

    private async syncTable(
        tableName: string,
        cursorColumn: string,
        lastCursor: string | null
    ): Promise<number> {
        if (!this.dataSource || !this.config) return 0

        // Build query against the external source
        let sql: string
        let params: unknown[]

        if (lastCursor !== null && lastCursor !== undefined) {
            sql = `SELECT * FROM ${tableName} WHERE ${cursorColumn} > ? ORDER BY ${cursorColumn} ASC LIMIT ${BATCH_SIZE}`
            params = [lastCursor]
        } else {
            sql = `SELECT * FROM ${tableName} ORDER BY ${cursorColumn} ASC LIMIT ${BATCH_SIZE}`
            params = []
        }

        const externalRows = await executeExternalQuery({
            sql,
            params,
            dataSource: this.dataSource,
            config: this.config,
        })

        if (!Array.isArray(externalRows) || externalRows.length === 0) {
            return 0
        }

        const columns = Object.keys(externalRows[0])

        if (columns.length === 0) {
            return 0
        }

        // Ensure the target table exists in internal SQLite with the same columns
        await this.ensureInternalTable(tableName, columns)

        // Upsert rows into internal SQLite. We do it one row at a time to stay
        // compatible with the existing rpc.executeQuery interface and to avoid
        // exceeding SQLite parameter limits on large column sets.
        let newCursor: string | null = lastCursor

        for (const row of externalRows) {
            const values = columns.map((col) => row[col] ?? null)
            const placeholders = columns.map(() => '?').join(', ')
            const columnList = columns.map((c) => `"${c}"`).join(', ')

            const insertSQL = `
                INSERT OR REPLACE INTO "${tableName}" (${columnList})
                VALUES (${placeholders})
            `

            await this.dataSource.rpc.executeQuery({
                sql: insertSQL,
                params: values,
            })

            // Track the maximum cursor value seen in this batch
            const cursorValue = row[cursorColumn]
            if (cursorValue !== undefined && cursorValue !== null) {
                const cursorStr = String(cursorValue)
                if (
                    newCursor === null ||
                    newCursor === lastCursor ||
                    cursorStr > newCursor
                ) {
                    newCursor = cursorStr
                }
            }
        }

        // Persist updated sync state
        await this.dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.UPSERT_STATE,
            params: [tableName, newCursor, externalRows.length],
        })

        return externalRows.length
    }

    /**
     * Creates the internal replica table if it does not yet exist. Column types
     * are declared as TEXT to remain schema-agnostic across source databases.
     */
    private async ensureInternalTable(
        tableName: string,
        columns: string[]
    ): Promise<void> {
        if (!this.dataSource) return

        const columnDefs = columns
            .map((col) => `"${col}" TEXT`)
            .join(',\n            ')

        const createSQL = `
            CREATE TABLE IF NOT EXISTS "${tableName}" (
                ${columnDefs}
            )
        `

        await this.dataSource.rpc.executeQuery({
            sql: createSQL,
            params: [],
        })
    }
}
