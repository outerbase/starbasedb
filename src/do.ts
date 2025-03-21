/// <reference types="@cloudflare/workers-types" />

import { handleWebSocketMessage } from './utils'
import { DatabaseDumper } from './dump/index'
import { DumpOptions, DumpState } from './types'
import type {
    DurableObject,
    DurableObjectState,
    WebSocket as CloudflareWebSocket,
    Request as CloudflareRequest,
    Response as CloudflareResponse,
} from '@cloudflare/workers-types'
import type { R2Bucket } from '@cloudflare/workers-types'
import { DataSource } from './types'
import { processDumpChunk } from './export/index'

// Add these constants at the top of the file
const CHUNK_SIZE = 1000
const BREATHING_INTERVAL = 5000

interface Env {
    CLIENT_AUTHORIZATION_TOKEN: string
    R2_BUCKET: R2Bucket
}

interface ExportRequestBody {
    callbackUrl: string
}

type DurableWebSocket = WebSocket & { accept(): void }

type WebSocketMessageEvent = {
    data: string | ArrayBuffer
    type: string
    target: WebSocket
}

export class StarbaseDBDurableObject implements DurableObject {
    private eventCallbacks: Array<(event: any) => void> = []
    private ctx: DurableObjectState
    private r2Bucket: R2Bucket
    public connections = new Map<string, WebSocket>()
    private clientAuthToken: string
    public sql: SqlStorage
    public storage: DurableObjectStorage

    /**
     * The constructor is invoked once upon creation of the Durable Object, i.e. the first call to
     * 	`DurableObjectStub::get` for a given identifier (no-op constructors can be omitted)
     *
     * @param ctx - The interface for interacting with Durable Object state
     * @param env - The interface to reference bindings declared in wrangler.toml
     */
    constructor(state: DurableObjectState, env: any) {
        this.eventCallbacks = []
        this.ctx = state
        this.clientAuthToken = env.CLIENT_AUTHORIZATION_TOKEN
        this.sql = state.storage.sql
        this.storage = state.storage
        this.r2Bucket = env.R2_BUCKET

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
            // Check for any in-progress dumps that need to continue
            await DatabaseDumper.continueProcessing(
                {
                    source: 'internal',
                    rpc: {
                        executeQuery: async (query) => this.executeQuery(query),
                    },
                    storage: {
                        get: this.storage.get.bind(this.storage),
                        put: this.storage.put.bind(this.storage),
                        setAlarm: (time: number, options?: { data?: any }) =>
                            this.storage.setAlarm(
                                time,
                                options as DurableObjectSetAlarmOptions
                            ),
                    },
                },
                {
                    BUCKET: this.r2Bucket as any,
                    role: 'admin' as const,
                    outerbaseApiKey: '',
                    features: {
                        allowlist: false,
                        rls: false,
                        rest: false,
                        export: true,
                        import: false,
                    },
                    export: {
                        chunkSize: CHUNK_SIZE,
                        breathingTimeMs: BREATHING_INTERVAL,
                        timeoutMs: 25000,
                        maxRetries: 3,
                    },
                }
            )
        } catch (error) {
            console.error('Error in alarm handler:', error)
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

    async fetch(request: CloudflareRequest): Promise<CloudflareResponse> {
        const url = new URL(request.url)

        if (url.pathname === '/ws') {
            const webSocketPair = new WebSocketPair()
            const [client, server] = Object.values(webSocketPair)

            if (server.accept) {
                server.accept()
            } else {
                console.error('WebSocket accept method is not defined.')
            }

            server.addEventListener('message', (async (msg: Event) => {
                const wsMsg = msg as unknown as { data: string | ArrayBuffer }
                await this.webSocketMessage(
                    server as unknown as CloudflareWebSocket,
                    wsMsg.data
                )
            }) as EventListener)

            return new Response(null, {
                status: 101,
                webSocket: client as unknown as WebSocket,
            }) as unknown as CloudflareResponse
        }

        if (url.pathname === '/socket') {
            if (request.headers.get('upgrade') === 'websocket') {
                const sessionId = url.searchParams.get('sessionId') ?? undefined
                return this.clientConnected(sessionId)
            }
            return new Response('Expected WebSocket', {
                status: 400,
            }) as unknown as CloudflareResponse
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

            return new Response('Broadcast sent', {
                status: 200,
            }) as unknown as CloudflareResponse
        }

        if (url.pathname === '/export') {
            const { callbackUrl } = (await request.json()) as ExportRequestBody
            await this.exportDatabase(callbackUrl)
            return new Response('Export started', {
                status: 202,
            }) as unknown as CloudflareResponse
        }

        return new Response('Unknown operation', {
            status: 400,
        }) as unknown as CloudflareResponse
    }

    public async clientConnected(sessionId?: string) {
        const webSocketPair = new WebSocketPair()
        const [client, server] = Object.values(webSocketPair)
        const wsSessionId = sessionId ?? crypto.randomUUID()

        // Store the server-side socket instead of client-side
        this.connections.set(wsSessionId, server)

        // Accept and configure the WebSocket
        if (server.accept) {
            server.accept()
        } else {
            console.error('WebSocket accept method is not defined.')
        }

        // Add message and error handling
        server.addEventListener('message', (async (msg: Event) => {
            const wsMsg = msg as unknown as { data: string | ArrayBuffer }
            await this.webSocketMessage(
                server as unknown as CloudflareWebSocket,
                wsMsg.data
            )
        }) as EventListener)

        server.addEventListener('error', (err) => {
            console.error(`WebSocket error for ${wsSessionId}:`, err)
            this.connections.delete(wsSessionId)
        })

        return new Response(null, {
            status: 101,
            webSocket: client as unknown as WebSocket,
        }) as unknown as CloudflareResponse
    }

    webSocketMessage(
        ws: CloudflareWebSocket,
        message: string | ArrayBuffer
    ): void | Promise<void> {
        return handleWebSocketMessage(ws as any, message)
    }

    webSocketClose(
        ws: any,
        code: number,
        reason: string,
        wasClean: boolean
    ): void {
        ws.close(code, reason)
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
    }): Promise<Record<string, SqlStorageValue>[]> {
        const cursor = await this.executeRawQuery(opts)

        if (opts.isRaw) {
            return cursor.toArray() // Ensure this returns an array
        }

        return cursor.toArray() // Always return an array of records
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

    async exportDatabase(callbackUrl: string): Promise<void> {
        const dumpFileName = `dump_${new Date().toISOString()}.sql`
        let currentChunkIndex = 0
        const chunkSize = 100 // Number of rows per chunk
        let isExporting = true

        while (isExporting) {
            const chunk = await this.fetchChunk(currentChunkIndex, chunkSize)
            if (chunk.length === 0) {
                isExporting = false
                break
            }

            const dumpContent = this.generateDumpContent(chunk)
            await this.r2Bucket.put(dumpFileName, dumpContent, {
                httpMetadata: { contentType: 'text/plain' },
            })

            currentChunkIndex += chunkSize

            await this.scheduleBreathingInterval()
        }

        await this.notifyCompletion(callbackUrl, dumpFileName)
    }

    private async fetchChunk(startIndex: number, size: number): Promise<any[]> {
        const sql = `SELECT * FROM your_table LIMIT ${size} OFFSET ${startIndex}`
        const result = await this.executeQuery({ sql })
        return result
    }

    private generateDumpContent(rows: any[]): string {
        return rows
            .map((row) => {
                const values = Object.values(row).map((value) =>
                    typeof value === 'string'
                        ? `'${value.replace(/'/g, "''")}'`
                        : value
                )
                return `INSERT INTO your_table VALUES (${values.join(', ')});\n`
            })
            .join('')
    }

    private async scheduleBreathingInterval(): Promise<void> {
        await this.setAlarm(Date.now() + 5000) // Pause for 5 seconds
        await this.setAlarm(Date.now() + 5000) // Allow other tasks to process
    }

    private async notifyCompletion(
        callbackUrl: string,
        dumpFileName: string
    ): Promise<void> {
        await fetch(callbackUrl, {
            method: 'POST',
            body: JSON.stringify({
                message: 'Dump completed',
                fileName: dumpFileName,
            }),
            headers: { 'Content-Type': 'application/json' },
        })
    }

    public async startDatabaseDump(
        id: string,
        options: DumpOptions
    ): Promise<void> {
        const storageAdapter = {
            get: this.storage.get.bind(this.storage),
            put: this.storage.put.bind(this.storage),
            setAlarm: (time: number, options?: { data?: any }) =>
                this.storage.setAlarm(
                    time,
                    options as DurableObjectSetAlarmOptions
                ),
        }

        const dumper = new DatabaseDumper(
            {
                source: 'internal',
                rpc: {
                    executeQuery: async (query) => this.executeQuery(query),
                },
                storage: storageAdapter,
            },
            {
                format: options.format,
                callbackUrl: options.callbackUrl,
                chunkSize: options.chunkSize,
                dumpId: id,
            },
            {
                BUCKET: this.r2Bucket as any,
                role: 'admin' as const,
                outerbaseApiKey: '',
                features: {
                    allowlist: false,
                    rls: false,
                    rest: false,
                    export: false,
                    import: false,
                },
            }
        )
        await dumper.start()
    }
}
