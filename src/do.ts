import { DurableObject } from 'cloudflare:workers'
import {
    ALARM_SLOTS_TABLE,
    DUMP_JOBS_SCHEMA_SQL,
    DUMP_JOBS_TABLE,
    DumpJobRecord,
    processDumpJobSlice,
} from './export/dump'

const ALARM_SLOTS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ${ALARM_SLOTS_TABLE} (
    slot TEXT PRIMARY KEY,
    scheduled_at INTEGER NOT NULL
);`

type AlarmSlot = 'cron' | 'dump'

export class StarbaseDBDurableObject extends DurableObject {
    // Durable storage for the SQL database
    public sql: SqlStorage
    // Durable storage for the instance
    public storage: DurableObjectStorage
    // Map of WebSocket connections to their corresponding session IDs
    public connections = new Map<string, WebSocket>()
    // Store the client auth token for requests back to our Worker
    private clientAuthToken: string
    // Optional R2 bucket binding for large resumable database dumps
    private dumpBucket?: R2Bucket
    // Cached alarm slots to skip no-op SQL writes on repeated CronPlugin middleware calls
    private cachedAlarmSlots?: Record<AlarmSlot, number | null>

    /**
     * The constructor is invoked once upon creation of the Durable Object, i.e. the first call to
     * 	`DurableObjectStub::get` for a given identifier (no-op constructors can be omitted)
     *
     * @param ctx - The interface for interacting with Durable Object state
     * @param env - The interface to reference bindings declared in wrangler.toml
     */
    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env)
        this.clientAuthToken = env.CLIENT_AUTHORIZATION_TOKEN
        this.dumpBucket = env.DUMP_BUCKET
        this.sql = ctx.storage.sql
        this.storage = ctx.storage

        // Install default necessary `tmp_` tables for various features here.
        const cacheStatement = `
        CREATE TABLE IF NOT EXISTS tmp_cache (
            "id" INTEGER PRIMARY KEY AUTOINCREMENT,
            "timestamp" REAL NOT NULL,
            "ttl" INTEGER NOT NULL,
            "query" TEXT UNIQUE NOT NULL,
            "results" TEXT
        );`

        const allowlistStatement = `
        CREATE TABLE IF NOT EXISTS tmp_allowlist_queries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sql_statement TEXT NOT NULL,
            source TEXT DEFAULT 'external'
        )`
        const allowlistRejectedStatement = `
        CREATE TABLE IF NOT EXISTS tmp_allowlist_rejections (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sql_statement TEXT NOT NULL,
            source TEXT DEFAULT 'external',
            created_at TEXT DEFAULT (datetime('now'))
        )`

        const rlsStatement = `
        CREATE TABLE IF NOT EXISTS tmp_rls_policies (
            "id" INTEGER PRIMARY KEY AUTOINCREMENT,
            "actions" TEXT NOT NULL CHECK(actions IN ('SELECT', 'UPDATE', 'INSERT', 'DELETE')),
            "schema" TEXT,
            "table" TEXT NOT NULL,
            "column" TEXT NOT NULL,
            "value" TEXT NOT NULL,
            "value_type" TEXT NOT NULL DEFAULT 'string',
            "operator" TEXT DEFAULT '='
        )`

        this.executeQuery({ sql: cacheStatement })
        this.executeQuery({ sql: allowlistStatement })
        this.executeQuery({ sql: allowlistRejectedStatement })
        this.executeQuery({ sql: rlsStatement })
        this.sql.exec(DUMP_JOBS_SCHEMA_SQL)
        this.sql.exec(ALARM_SLOTS_SCHEMA_SQL)
    }

    init() {
        return {
            getAlarm: this.getAlarm.bind(this),
            setAlarm: this.setAlarm.bind(this),
            scheduleDumpAlarm: this.scheduleDumpAlarm.bind(this),
            deleteAlarm: this.deleteAlarm.bind(this),
            getStatistics: this.getStatistics.bind(this),
            executeQuery: this.executeQuery.bind(this),
        }
    }

    public async getAlarm(): Promise<number | null> {
        return await this.storage.getAlarm()
    }

    private async readAlarmSlots(): Promise<Record<AlarmSlot, number | null>> {
        if (this.cachedAlarmSlots) {
            return { ...this.cachedAlarmSlots }
        }
        const slots: Record<AlarmSlot, number | null> = {
            cron: null,
            dump: null,
        }
        try {
            const rows = (await this.executeQuery({
                sql: `SELECT slot, scheduled_at FROM ${ALARM_SLOTS_TABLE};`,
                isRaw: false,
            })) as Record<string, SqlStorageValue>[]
            for (const row of rows) {
                const slot = String(row.slot ?? '')
                const ts = Number(row.scheduled_at)
                if (
                    (slot === 'cron' || slot === 'dump') &&
                    Number.isFinite(ts)
                ) {
                    slots[slot] = ts
                }
            }
        } catch (err) {
            console.error('Error reading alarm slots:', err)
        }
        this.cachedAlarmSlots = { ...slots }
        return slots
    }

    private async upsertAlarmSlot(
        slot: AlarmSlot,
        scheduledAt: number
    ): Promise<void> {
        await this.executeQuery({
            sql: `INSERT OR REPLACE INTO ${ALARM_SLOTS_TABLE} (slot, scheduled_at) VALUES (?, ?);`,
            params: [slot, scheduledAt],
        })
        if (this.cachedAlarmSlots) {
            this.cachedAlarmSlots[slot] = scheduledAt
        }
    }

    private async clearAlarmSlot(slot: AlarmSlot): Promise<void> {
        await this.executeQuery({
            sql: `DELETE FROM ${ALARM_SLOTS_TABLE} WHERE slot = ?;`,
            params: [slot],
        })
        if (this.cachedAlarmSlots) {
            this.cachedAlarmSlots[slot] = null
        }
    }

    private async syncPhysicalAlarm(
        options?: DurableObjectSetAlarmOptions,
        forceRearm = false
    ): Promise<void> {
        const slots = await this.readAlarmSlots()
        const candidates = [slots.cron, slots.dump].filter(
            (v): v is number => v !== null && Number.isFinite(v)
        )
        if (candidates.length === 0) return

        const earliest = Math.min(...candidates)
        if (!forceRearm) {
            // Never push back an already-scheduled earlier/due physical alarm (prevents starvation under traffic).
            const currentPhysical = await this.storage
                .getAlarm()
                .catch(() => null)
            if (currentPhysical !== null && currentPhysical <= earliest) {
                return
            }
        }
        await this.storage.setAlarm(earliest, options)
    }

    private async scheduleSlotAlarm(
        slot: AlarmSlot,
        scheduledTime: number | Date,
        options?: DurableObjectSetAlarmOptions
    ): Promise<void> {
        const now = Date.now()
        const inputTime =
            scheduledTime instanceof Date
                ? scheduledTime.getTime()
                : scheduledTime
        const finalTime = Math.max(inputTime, now + 1000)

        const slots = await this.readAlarmSlots()
        if (
            slot === 'cron' &&
            slots.cron !== null &&
            inputTime <= slots.cron &&
            finalTime >= slots.cron &&
            slots.cron >= now
        ) {
            // Preserve unchanged or final-second cron deadlines without clamping them past
            // the already-armed physical alarm, and skip redundant SQLite writes.
            await this.syncPhysicalAlarm(options)
            return
        }

        // Preserve an earlier pending dump wake-up so a slower job never delays a faster one
        const nextSlotTime =
            slot === 'dump' && slots.dump !== null
                ? Math.min(slots.dump, finalTime)
                : finalTime

        if (slots[slot] !== nextSlotTime) {
            await this.upsertAlarmSlot(slot, nextSlotTime)
        }
        await this.syncPhysicalAlarm(options)
    }

    public async setAlarm(
        scheduledTime: number | Date,
        options?: DurableObjectSetAlarmOptions
    ): Promise<void> {
        try {
            await this.scheduleSlotAlarm('cron', scheduledTime, options)
        } catch (e) {
            console.error('Error setting alarm: ', e)
            throw e
        }
    }

    public async scheduleDumpAlarm(
        scheduledTime: number | Date,
        options?: DurableObjectSetAlarmOptions
    ): Promise<void> {
        try {
            await this.scheduleSlotAlarm('dump', scheduledTime, options)
        } catch (e) {
            console.error('Error setting dump alarm: ', e)
            throw e
        }
    }

    public async deleteAlarm(
        options?: DurableObjectSetAlarmOptions
    ): Promise<void> {
        await this.clearAlarmSlot('cron')
        const slots = await this.readAlarmSlots()
        if (slots.dump !== null) {
            await this.syncPhysicalAlarm(options, true)
            return
        }
        return this.storage.deleteAlarm(options)
    }

    async alarm() {
        const now = Date.now()
        // Refresh cached slots on alarm entry to reflect durable SQLite state
        this.cachedAlarmSlots = undefined
        const initialSlots = await this.readAlarmSlots()
        const dumpDue = initialSlots.dump === null || initialSlots.dump <= now
        let ranDumpJob = false

        // 1. Continue any active resumable database dump jobs with breathing intervals
        if (dumpDue) {
            try {
                const activeDumpJobs = (await this.executeQuery({
                    sql: `SELECT * FROM ${DUMP_JOBS_TABLE} WHERE status = 'in_progress' ORDER BY created_at ASC LIMIT 1;`,
                    isRaw: false,
                })) as Record<string, SqlStorageValue>[]

                if (activeDumpJobs.length > 0) {
                    ranDumpJob = true
                    await this.clearAlarmSlot('dump')
                    const job = activeDumpJobs[0] as unknown as DumpJobRecord
                    const updated = await processDumpJobSlice({
                        job,
                        executeSql: async (sql, params) =>
                            (await this.executeQuery({
                                sql,
                                params,
                                isRaw: false,
                            })) as Record<string, any>[],
                        bucket: this.dumpBucket,
                        scheduleAlarm: async (scheduledTime) => {
                            await this.scheduleDumpAlarm(scheduledTime)
                        },
                    })

                    if (updated.status !== 'in_progress') {
                        const remaining = (await this.executeQuery({
                            sql: `SELECT id FROM ${DUMP_JOBS_TABLE} WHERE status = 'in_progress' LIMIT 1;`,
                            isRaw: false,
                        })) as Record<string, SqlStorageValue>[]
                        if (remaining.length > 0) {
                            await this.scheduleDumpAlarm(Date.now() + 1000)
                        }
                    }
                } else if (initialSlots.dump !== null) {
                    await this.clearAlarmSlot('dump')
                }
            } catch (dumpErr) {
                console.error('Error processing dump job alarm:', dumpErr)
            }
        }

        // 2. Process active cron plugin tasks ONLY when cron slot is actually due (strict <= now)
        const cronDue =
            initialSlots.cron !== null ? initialSlots.cron <= now : !ranDumpJob

        if (cronDue) {
            if (initialSlots.cron !== null) {
                await this.clearAlarmSlot('cron')
            }
            try {
                const task = (await this.executeQuery({
                    sql: 'SELECT * FROM tmp_cron_tasks WHERE is_active = 1;',
                    isRaw: false,
                })) as Record<string, SqlStorageValue>[]

                if (task.length) {
                    const firstTask = task[0]
                    await fetch(`${firstTask.callback_host}/cron/callback`, {
                        method: 'POST',
                        headers: {
                            Authorization: `Bearer ${this.clientAuthToken}`,
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify(task ?? []),
                    })
                }
            } catch (e: any) {
                if (
                    !(
                        typeof e?.message === 'string' &&
                        e.message.includes('no such table')
                    )
                ) {
                    console.error('There was an error processing an alarm: ', e)
                    await this.setAlarm(Date.now() + 60000).catch((retryErr) =>
                        console.error('Failed to set recovery alarm:', retryErr)
                    )
                }
            }
        }

        // 3. Re-arm the single physical DO alarm to the earliest remaining slot
        await this.syncPhysicalAlarm(undefined, true).catch((syncErr) =>
            console.error('Failed to synchronize remaining alarm:', syncErr)
        )
    }

    public async getStatistics(): Promise<{
        databaseSize: number
        activeConnections: number
        recentQueries: number
    }> {
        const sql = `SELECT COUNT(*) as count 
            FROM tmp_query_log 
            WHERE created_at >= datetime('now', '-24 hours')`
        const result = (await this.executeQuery({
            sql,
            isRaw: false,
        })) as Record<string, SqlStorageValue>[]
        const row = result.length ? result[0] : { count: 0 }

        return {
            // Size in bytes
            databaseSize: this.sql.databaseSize,
            // Count of persistent web socket connections
            activeConnections: this.connections.size,
            // Assuming the `QueryLogPlugin` is in use, count is of the last 24 hours
            recentQueries: Number(row.count),
        }
    }

    async fetch(request: Request) {
        const url = new URL(request.url)

        if (url.pathname === '/socket') {
            if (request.headers.get('upgrade') === 'websocket') {
                const sessionId = url.searchParams.get('sessionId') ?? undefined
                return this.clientConnected(sessionId)
            }
            return new Response('Expected WebSocket', { status: 400 })
        }

        if (url.pathname === '/socket/broadcast') {
            const message = await request.json()
            const sessionId = url.searchParams.get('sessionId') ?? undefined

            // Broadcast to all connected clients using server-side sockets
            for (const [id, connection] of this.connections) {
                try {
                    // If the broadcast event included a specific sessionId then we should expect
                    // that message was intended to be broadcasted to a particular session only.
                    if (sessionId && sessionId != id) {
                        continue
                    }

                    connection.send(JSON.stringify(message))
                } catch (err) {
                    // Clean up dead connections
                    this.connections.delete(id)
                }
            }

            return new Response('Broadcast sent', { status: 200 })
        }

        return new Response('Unknown operation', { status: 400 })
    }

    public async clientConnected(sessionId?: string) {
        const webSocketPair = new WebSocketPair()
        const [client, server] = Object.values(webSocketPair)
        const wsSessionId = sessionId ?? crypto.randomUUID()

        // Store the server-side socket instead of client-side
        this.connections.set(wsSessionId, server)

        // Accept and configure the WebSocket
        server.accept()

        // Add message and error handling
        server.addEventListener('message', async (msg) => {
            await this.webSocketMessage(server, msg.data)
        })

        server.addEventListener('error', (err) => {
            console.error(`WebSocket error for ${wsSessionId}:`, err)
            this.connections.delete(wsSessionId)
        })

        return new Response(null, { status: 101, webSocket: client })
    }

    async webSocketMessage(ws: WebSocket, message: any) {
        const { sql, params, action } = JSON.parse(message)

        if (action === 'query') {
            const queries = [{ sql, params }]
            const result = await this.executeTransaction(queries, false)
            ws.send(JSON.stringify(result))
        }
    }

    async webSocketClose(
        ws: WebSocket,
        code: number,
        reason: string,
        wasClean: boolean
    ) {
        // If the client closes the connection, the runtime will invoke the webSocketClose() handler.
        ws.close(code, 'StarbaseDB is closing WebSocket connection')

        // Remove the WebSocket connection from the map
        const tags = this.ctx.getTags(ws)
        if (tags.length) {
            const wsSessionId = tags[0]
            this.connections.delete(wsSessionId)
        }
    }

    private async executeRawQuery<
        T extends Record<string, SqlStorageValue> = Record<
            string,
            SqlStorageValue
        >,
    >(opts: { sql: string; params?: unknown[] }) {
        const { sql, params } = opts

        try {
            let cursor

            if (params && params.length) {
                cursor = this.sql.exec<T>(sql, ...params)
            } else {
                cursor = this.sql.exec<T>(sql)
            }

            return cursor
        } catch (error) {
            console.error('SQL Execution Error:', error)
            throw error
        }
    }

    public async executeQuery(opts: {
        sql: string
        params?: unknown[]
        isRaw?: boolean
    }) {
        const cursor = await this.executeRawQuery(opts)

        if (opts.isRaw) {
            return {
                columns: cursor.columnNames,
                rows: Array.from(cursor.raw()),
                meta: {
                    rows_read: cursor.rowsRead,
                    rows_written: cursor.rowsWritten,
                },
            }
        }

        return cursor.toArray()
    }

    public async executeTransaction(
        queries: { sql: string; params?: unknown[] }[],
        isRaw: boolean
    ): Promise<any[]> {
        const results = []

        try {
            for (const queryObj of queries) {
                const { sql, params } = queryObj
                const result = await this.executeQuery({ sql, params, isRaw })
                results.push(result)
            }

            return results
        } catch (error) {
            console.error('Transaction Execution Error:', error)
            throw error
        }
    }
}
