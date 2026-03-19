import { DurableObject } from 'cloudflare:workers'

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

        const exportJobsStatement = `
        CREATE TABLE IF NOT EXISTS tmp_export_jobs (
            id TEXT PRIMARY KEY,
            status TEXT NOT NULL CHECK(status IN ('processing', 'completed', 'failed')),
            error TEXT,
            callback_url TEXT,
            callback_sent INTEGER NOT NULL DEFAULT 0,
            callback_attempts INTEGER NOT NULL DEFAULT 0,
            next_callback_retry_at INTEGER,
            callback_host TEXT,
            artifact_key TEXT,
            artifact_provider TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            started_at INTEGER NOT NULL,
            completed_at INTEGER,
            current_table_index INTEGER NOT NULL DEFAULT 0,
            current_offset INTEGER NOT NULL DEFAULT 0,
            chunk_index INTEGER NOT NULL DEFAULT 0,
            total_tables INTEGER NOT NULL DEFAULT 0
        )`

        const exportJobTablesStatement = `
        CREATE TABLE IF NOT EXISTS tmp_export_job_tables (
            job_id TEXT NOT NULL,
            table_index INTEGER NOT NULL,
            table_name TEXT NOT NULL,
            PRIMARY KEY (job_id, table_index)
        )`

        const exportJobChunksStatement = `
        CREATE TABLE IF NOT EXISTS tmp_export_job_chunks (
            job_id TEXT NOT NULL,
            chunk_index INTEGER NOT NULL,
            content TEXT,
            PRIMARY KEY (job_id, chunk_index)
        )`

        this.executeQuery({ sql: cacheStatement })
        this.executeQuery({ sql: allowlistStatement })
        this.executeQuery({ sql: allowlistRejectedStatement })
        this.executeQuery({ sql: rlsStatement })
        this.executeQuery({ sql: exportJobsStatement })
        this.executeQuery({ sql: exportJobTablesStatement })
        this.executeQuery({ sql: exportJobChunksStatement })

        this.ensureExportSchemaUpgrades()
    }

    private ensureExportSchemaUpgrades() {
        const upgradeStatements = [
            `ALTER TABLE tmp_export_jobs ADD COLUMN callback_attempts INTEGER NOT NULL DEFAULT 0;`,
            `ALTER TABLE tmp_export_jobs ADD COLUMN next_callback_retry_at INTEGER;`,
        ]

        for (const sql of upgradeStatements) {
            this.executeQuery({ sql }).catch(() => {
                // Ignore if the column already exists.
            })
        }
    }

    init() {
        return {
            getAlarm: this.getAlarm.bind(this),
            setAlarm: this.setAlarm.bind(this),
            deleteAlarm: this.deleteAlarm.bind(this),
            getStatistics: this.getStatistics.bind(this),
            executeQuery: this.executeQuery.bind(this),
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
            const now = Date.now()

            const pendingExportJobs = (await this.executeQuery({
                sql: `SELECT id, callback_host
                      FROM tmp_export_jobs
                      WHERE status = 'processing' AND callback_host IS NOT NULL
                      ORDER BY updated_at ASC
                      LIMIT 1;`,
                isRaw: false,
            })) as Record<string, SqlStorageValue>[]

            if (pendingExportJobs.length) {
                const job = pendingExportJobs[0]

                try {
                    await fetch(`${job.callback_host}/export/dump/${job.id}`, {
                        method: 'GET',
                        headers: {
                            Authorization: `Bearer ${this.clientAuthToken}`,
                            'X-Starbase-Alarm': 'true',
                        },
                    })
                } catch (error) {
                    console.error('Failed to continue export via alarm:', error)
                }
            }

            const pendingCallbackJobs = (await this.executeQuery({
                sql: `SELECT id, callback_host
                      FROM tmp_export_jobs
                      WHERE status IN ('completed', 'failed')
                        AND callback_url IS NOT NULL
                        AND callback_sent = 0
                        AND callback_host IS NOT NULL
                        AND (
                            next_callback_retry_at IS NULL
                            OR next_callback_retry_at <= ?
                        )
                      ORDER BY updated_at ASC
                      LIMIT 1;`,
                params: [now],
                isRaw: false,
            })) as Record<string, SqlStorageValue>[]

            if (pendingCallbackJobs.length) {
                const callbackJob = pendingCallbackJobs[0]

                try {
                    await fetch(
                        `${callbackJob.callback_host}/export/dump/${callbackJob.id}`,
                        {
                            method: 'GET',
                            headers: {
                                Authorization: `Bearer ${this.clientAuthToken}`,
                                'X-Starbase-Alarm': 'true',
                            },
                        }
                    )
                } catch (error) {
                    console.error(
                        'Failed to continue callback retry via alarm:',
                        error
                    )
                }
            }

            const staleExportJobs = (await this.executeQuery({
                sql: `SELECT id
                      FROM tmp_export_jobs
                      WHERE status IN ('completed', 'failed')
                        AND completed_at IS NOT NULL
                        AND completed_at < ?
                      LIMIT 50;`,
                params: [now - 7 * 24 * 60 * 60 * 1000],
                isRaw: false,
            })) as Record<string, SqlStorageValue>[]

            for (const staleJob of staleExportJobs) {
                const jobId = String(staleJob.id)

                await this.executeQuery({
                    sql: `DELETE FROM tmp_export_job_chunks WHERE job_id = ?;`,
                    params: [jobId],
                })
                await this.executeQuery({
                    sql: `DELETE FROM tmp_export_job_tables WHERE job_id = ?;`,
                    params: [jobId],
                })
                await this.executeQuery({
                    sql: `DELETE FROM tmp_export_jobs WHERE id = ?;`,
                    params: [jobId],
                })
            }

            const remainingExportJobs = (await this.executeQuery({
                sql: `SELECT
                        (
                            SELECT COUNT(*)
                            FROM tmp_export_jobs
                            WHERE status = 'processing'
                        )
                        +
                        (
                            SELECT COUNT(*)
                            FROM tmp_export_jobs
                            WHERE status IN ('completed', 'failed')
                              AND callback_url IS NOT NULL
                              AND callback_sent = 0
                              AND (
                                  next_callback_retry_at IS NULL
                                  OR next_callback_retry_at <= ?
                              )
                        ) AS count;`,
                params: [now],
                isRaw: false,
            })) as Record<string, SqlStorageValue>[]

            const activeExportCount = Number(remainingExportJobs[0]?.count || 0)

            if (activeExportCount > 0) {
                await this.setAlarm(Date.now() + 2000)
            } else {
                const nextRetryRow = (await this.executeQuery({
                    sql: `SELECT MIN(next_callback_retry_at) AS next_retry
                          FROM tmp_export_jobs
                          WHERE status IN ('completed', 'failed')
                            AND callback_url IS NOT NULL
                            AND callback_sent = 0
                            AND next_callback_retry_at IS NOT NULL;`,
                    isRaw: false,
                })) as Record<string, SqlStorageValue>[]

                const nextRetry = Number(nextRetryRow[0]?.next_retry || 0)
                if (nextRetry > 0) {
                    await this.setAlarm(nextRetry)
                }
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
