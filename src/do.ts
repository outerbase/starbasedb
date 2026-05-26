import { DurableObject } from 'cloudflare:workers'
import { runTick } from './export/dump-engine'
import { createDumpHost, jobStateKey } from './export/do-dump-host'
import {
    DumpFormat,
    DumpJobOptions,
    DumpJobState,
    DumpJobStatusView,
    newJobState,
    toStatusView,
} from './export/streaming-dump'

const ACTIVE_DUMP_KEY = 'dump:active'
const DUMP_RESUME_DELAY_MS = 1_000

export class StarbaseDBDurableObject extends DurableObject {
    // Durable storage for the SQL database
    public sql: SqlStorage
    // Durable storage for the instance
    public storage: DurableObjectStorage
    // Map of WebSocket connections to their corresponding session IDs
    public connections = new Map<string, WebSocket>()
    // Store the client auth token for requests back to our Worker
    private clientAuthToken: string
    // R2 bucket binding for streaming dump output (optional).
    private dumpBucket: R2Bucket | undefined

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
        this.sql = ctx.storage.sql
        this.storage = ctx.storage
        this.dumpBucket = env.DATABASE_DUMPS

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
    }

    init() {
        return {
            getAlarm: this.getAlarm.bind(this),
            setAlarm: this.setAlarm.bind(this),
            deleteAlarm: this.deleteAlarm.bind(this),
            getStatistics: this.getStatistics.bind(this),
            executeQuery: this.executeQuery.bind(this),
            startDumpJob: this.startDumpJob.bind(this),
            getDumpJob: this.getDumpJob.bind(this),
            getDumpDownloadBody: this.getDumpDownloadBody.bind(this),
            cancelDumpJob: this.cancelDumpJob.bind(this),
        }
    }

    public async getAlarm(): Promise<number | null> {
        return await this.storage.getAlarm()
    }

    public async setAlarm(
        scheduledTime: number | Date,
        options?: DurableObjectSetAlarmOptions
    ): Promise<void> {
        try {
            const now = Date.now()
            const inputTime =
                scheduledTime instanceof Date
                    ? scheduledTime.getTime()
                    : scheduledTime

            // Ensure the time is in the future and at least 1 second from now
            const minimumTime = now + 1000
            const finalTime = Math.max(inputTime, minimumTime)
            await this.storage.setAlarm(finalTime, options)
        } catch (e) {
            console.error('Error setting alarm: ', e)
            throw e
        }
    }

    public deleteAlarm(options?: DurableObjectSetAlarmOptions): Promise<void> {
        return this.storage.deleteAlarm(options)
    }

    async alarm() {
        // Dispatch streaming dump work first so a long-running export does not
        // get starved by other alarm-driven features. The dump engine sets its
        // own continuation alarm if it needs another tick.
        try {
            await this.continueActiveDumpJob()
        } catch (err) {
            console.error('Failed to continue dump job:', err)
        }

        try {
            // Fetch all the tasks that are marked to emit an event for this cycle.
            // The cron table is created lazily by the CronPlugin; if it does not
            // exist yet (fresh DO with no cron plugin installed) we silently skip.
            let task: Record<string, SqlStorageValue>[] = []
            try {
                task = (await this.executeQuery({
                    sql: 'SELECT * FROM tmp_cron_tasks WHERE is_active = 1;',
                    isRaw: false,
                })) as Record<string, SqlStorageValue>[]
            } catch {
                return
            }

            if (!task.length) {
                return
            }

            try {
                const firstTask = task[0]
                await fetch(`${firstTask.callback_host}/cron/callback`, {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${this.clientAuthToken}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(task ?? []),
                })
            } catch (error) {
                console.error('Failed to call the alarm/cron callback:', error)

                // If the callback fails, we should try to reschedule to prevent the chain from breaking
                try {
                    await this.setAlarm(Date.now() + 60000)
                } catch (retryError) {
                    console.error('Failed to set recovery alarm:', retryError)
                }
            }
        } catch (e) {
            console.error('There was an error processing an alarm: ', e)

            // Try to recover by scheduling a retry in 1 minute
            try {
                await this.setAlarm(Date.now() + 60000)
            } catch (retryError) {
                console.error('Failed to set recovery alarm:', retryError)
            }
        }
    }

    // -- Streaming dump job machinery -------------------------------------

    /**
     * Begin a new streaming dump job. Creates the R2 multipart upload,
     * persists initial state, and schedules an immediate alarm to kick off
     * the first tick. Returns a status view the worker can hand back to the
     * client right away.
     */
    public async startDumpJob(
        options: DumpJobOptions
    ): Promise<DumpJobStatusView> {
        if (!this.dumpBucket) {
            throw new Error(
                'Streaming dump requires the DATABASE_DUMPS R2 binding. ' +
                    'Add an [[r2_buckets]] entry to wrangler.toml.'
            )
        }

        const tables = await this.listUserTables(options.table)
        const jobId = crypto.randomUUID()
        const state = newJobState(jobId, options, tables)

        // Open the R2 multipart upload up-front so part numbers and uploadId
        // are stable across alarm-driven continuations.
        const upload = await this.dumpBucket.createMultipartUpload(
            state.objectKey,
            {
                httpMetadata: {
                    contentType: this.contentTypeFor(options.format),
                    contentDisposition: `attachment; filename="${state.objectKey.split('/').pop()}"`,
                },
            }
        )
        state.uploadId = upload.uploadId

        await this.storage.put(jobStateKey(jobId), state)
        await this.storage.put(ACTIVE_DUMP_KEY, jobId)
        await this.setAlarm(Date.now() + 1000)
        return toStatusView(state)
    }

    /** Read the current state of a dump job for the status endpoint. */
    public async getDumpJob(jobId: string): Promise<DumpJobStatusView | null> {
        const state = await this.storage.get<DumpJobState>(jobStateKey(jobId))
        if (!state) return null
        return toStatusView(state)
    }

    /**
     * Stream the dump body from R2 back to the worker so it can be relayed to
     * the client. Returns null when the job is not finished yet or missing.
     */
    public async getDumpDownloadBody(jobId: string): Promise<{
        body: ReadableStream
        size: number
        contentType: string
        filename: string
    } | null> {
        if (!this.dumpBucket) return null
        const state = await this.storage.get<DumpJobState>(jobStateKey(jobId))
        if (!state || state.status !== 'completed') return null
        const obj = await this.dumpBucket.get(state.objectKey)
        if (!obj) return null
        return {
            body: obj.body,
            size: obj.size,
            contentType:
                obj.httpMetadata?.contentType ??
                this.contentTypeFor(state.format),
            filename: state.objectKey.split('/').pop() ?? state.objectKey,
        }
    }

    /** Cancel an in-flight dump job. Aborts the R2 multipart and marks failed. */
    public async cancelDumpJob(
        jobId: string
    ): Promise<DumpJobStatusView | null> {
        const state = await this.storage.get<DumpJobState>(jobStateKey(jobId))
        if (!state) return null
        if (state.status === 'completed' || state.status === 'failed')
            return toStatusView(state)

        if (this.dumpBucket && state.uploadId) {
            try {
                const upload = this.dumpBucket.resumeMultipartUpload(
                    state.objectKey,
                    state.uploadId
                )
                await upload.abort()
            } catch (err) {
                console.error('Failed to abort R2 multipart upload:', err)
            }
        }
        if (this.dumpBucket && state.pendingTempKey) {
            await this.dumpBucket.delete(state.pendingTempKey).catch(() => {})
        }
        state.status = 'cancelled'
        state.error = 'Cancelled by user'
        state.progress.updatedAt = Date.now()
        await this.storage.put(jobStateKey(jobId), state)
        const active = await this.storage.get<string>(ACTIVE_DUMP_KEY)
        if (active === jobId) await this.storage.delete(ACTIVE_DUMP_KEY)
        return toStatusView(state)
    }

    /**
     * Run one tick of the active dump job (if any). Called from alarm().
     * Persists state after every tick and re-arms the alarm if more work
     * remains.
     */
    private async continueActiveDumpJob(): Promise<void> {
        const activeId = await this.storage.get<string>(ACTIVE_DUMP_KEY)
        if (!activeId) return
        if (!this.dumpBucket) {
            console.error(
                'Active dump job exists but DATABASE_DUMPS R2 binding is missing.'
            )
            await this.storage.delete(ACTIVE_DUMP_KEY)
            return
        }
        const state = await this.storage.get<DumpJobState>(
            jobStateKey(activeId)
        )
        if (!state) {
            await this.storage.delete(ACTIVE_DUMP_KEY)
            return
        }
        if (
            state.status === 'completed' ||
            state.status === 'failed' ||
            state.status === 'cancelled'
        ) {
            await this.storage.delete(ACTIVE_DUMP_KEY)
            return
        }

        const host = createDumpHost({
            sql: this.sql,
            storage: this.storage,
            bucket: this.dumpBucket,
        })

        try {
            const { done } = await runTick(state, host)
            await this.storage.put(jobStateKey(state.jobId), state)
            if (done) {
                await this.storage.delete(ACTIVE_DUMP_KEY)
                if (state.callbackUrl) {
                    this.fireDumpCallback(state).catch((err) =>
                        console.error('Dump callback failed:', err)
                    )
                }
            } else {
                await this.setAlarm(Date.now() + DUMP_RESUME_DELAY_MS)
            }
        } catch (err) {
            console.error('Dump engine error:', err)
            // The engine sets state.status='failed' before throwing. Persist
            // the failure so callers see it via the status endpoint.
            state.status = 'failed'
            state.error =
                err instanceof Error ? err.message : String(err ?? 'unknown')
            state.progress.updatedAt = Date.now()
            await this.storage.put(jobStateKey(state.jobId), state)
            await this.storage.delete(ACTIVE_DUMP_KEY)
            if (state.callbackUrl) {
                this.fireDumpCallback(state).catch((cbErr) =>
                    console.error('Dump failure callback failed:', cbErr)
                )
            }
        }
    }

    private async fireDumpCallback(state: DumpJobState): Promise<void> {
        if (!state.callbackUrl) return
        try {
            await fetch(state.callbackUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(toStatusView(state)),
            })
        } catch (err) {
            console.error('Failed to fire dump completion callback:', err)
        }
    }

    /**
     * List the user-facing tables this DO holds. Excludes SQLite internal
     * tables and the tmp_* feature tables which would otherwise leak into
     * the export.
     */
    private async listUserTables(only?: string): Promise<string[]> {
        if (only) {
            const exists = (await this.executeQuery({
                sql: 'SELECT name FROM sqlite_master WHERE type = ? AND name = ?;',
                params: ['table', only],
                isRaw: false,
            })) as Record<string, SqlStorageValue>[]
            return exists.length ? [only] : []
        }
        const rows = (await this.executeQuery({
            sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'tmp_%' AND name NOT LIKE '_cf_%' ORDER BY name;",
            isRaw: false,
        })) as Record<string, SqlStorageValue>[]
        return rows.map((r) => String(r.name))
    }

    private contentTypeFor(format: DumpFormat): string {
        if (format === 'csv') return 'text/csv'
        if (format === 'json') return 'application/json'
        return 'application/sql'
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
