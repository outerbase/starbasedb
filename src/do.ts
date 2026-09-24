import { DurableObject } from 'cloudflare:workers'
import { DUMP_STATE_KEY, type DumpState } from './export/chunkedDump'
import type { DataSource } from './types'
import type { StarbaseDBConfiguration } from './handler'

export class StarbaseDBDurableObject extends DurableObject {
    // Durable storage for the SQL database
    public sql: SqlStorage
    // Durable storage for the instance
    public storage: DurableObjectStorage
    // Map of WebSocket connections to their corresponding session IDs
    public connections = new Map<string, WebSocket>()
    // Store the client auth token for requests back to our Worker
    private clientAuthToken: string

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
            dumpJobStatus: this.dumpJobStatus.bind(this),
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
        try {
            // A chunked dump job in flight takes priority: resume its next
            // bounded cycle (breathing interval already elapsed). The dump job
            // always targets the internal source, which is this DO itself.
            const dumpState = await this.storage.get<DumpState>(DUMP_STATE_KEY)
            if (dumpState && !dumpState.completedAt) {
                const { runDumpJob } = await import('./export/dump')
                await runDumpJob(
                    {
                        storage: this.storage,
                        env: {
                            R2_DUMP_BUCKET: (
                                this.env as Env & { R2_DUMP_BUCKET?: R2Bucket }
                            ).R2_DUMP_BUCKET,
                        },
                        dataSource: this.dumpJobDataSource(),
                        config: { role: 'admin' } as StarbaseDBConfiguration,
                        setAlarm: (time, options) =>
                            this.setAlarm(time, options),
                    },
                    new URLSearchParams()
                )
                return
            }

            // A finished dump that has not been consolidated yet: merge its
            // chunk records into the single R2 object (multipart, resumable)
            // so presigned download URLs become available.
            if (
                dumpState &&
                dumpState.completedAt &&
                (this.env as Env & { R2_DUMP_BUCKET?: R2Bucket })
                    .R2_DUMP_BUCKET &&
                (!dumpState.finalizedAt || !dumpState.temporaryChunksCleanedAt)
            ) {
                const { runDumpFinalize } = await import('./export/dump')
                await runDumpFinalize({
                    storage: this.storage,
                    env: {
                        R2_DUMP_BUCKET: (
                            this.env as Env & { R2_DUMP_BUCKET?: R2Bucket }
                        ).R2_DUMP_BUCKET,
                    },
                    dataSource: this.dumpJobDataSource(),
                    config: { role: 'admin' } as StarbaseDBConfiguration,
                    setAlarm: (time, options) => this.setAlarm(time, options),
                })
                return
            }

            // Fetch all the tasks that are marked to emit an event for this cycle.
            const task = (await this.executeQuery({
                sql: 'SELECT * FROM tmp_cron_tasks WHERE is_active = 1;',
                isRaw: false,
            })) as Record<string, SqlStorageValue>[]

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

    /**
     * Internal data source for dump jobs. Built in-process (no RPC hop): the
     * engine's queries execute directly against this DO's SQLite storage.
     */
    private dumpJobDataSource(): DataSource {
        return {
            source: 'internal',
            rpc: this.init(),
        } as unknown as DataSource
    }

    /**
     * Chunked dump job entry point, executed inside the Durable Object so it
     * can drive bounded work cycles, persist progress, mirror chunks to R2
     * (when bound) and resume itself through the DO alarm. Takes only plain
     * config/params so the RPC surface avoids circular DataSource typings.
     */
    public async startDumpJob(
        config: StarbaseDBConfiguration,
        searchParams: Record<string, string>
    ): Promise<Response> {
        const { runDumpJob } = await import('./export/dump')
        return runDumpJob(
            {
                storage: this.storage,
                env: {
                    // Optional binding; deployers add it to wrangler.toml when
                    // they want R2-backed dumps. Absent = storage-only mode.
                    R2_DUMP_BUCKET: (
                        this.env as Env & { R2_DUMP_BUCKET?: R2Bucket }
                    ).R2_DUMP_BUCKET,
                },
                dataSource: this.dumpJobDataSource(),
                config,
                setAlarm: (time, options) => this.setAlarm(time, options),
            },
            new URLSearchParams(searchParams)
        )
    }

    /** Status/fetch endpoint for a chunked dump job. */
    public async dumpJobStatus(
        config: StarbaseDBConfiguration
    ): Promise<Response> {
        const { dumpJobStatus } = await import('./export/dump')
        return dumpJobStatus({
            storage: this.storage,
            env: {
                R2_DUMP_BUCKET: (
                    this.env as Env & { R2_DUMP_BUCKET?: R2Bucket }
                ).R2_DUMP_BUCKET,
            },
            dataSource: this.dumpJobDataSource(),
            config,
            setAlarm: (time, options) => this.setAlarm(time, options),
        })
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
