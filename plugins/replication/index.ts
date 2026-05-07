import { StarbasePlugin } from '../../src/plugin'
import type { StarbaseApp } from '../../src/handler'
import type { DataSource } from '../../src/types'
import { Parser } from 'node-sql-parser'

// Defined as a structural type rather than referencing the global directly,
// ensuring compatibility across TypeScript configurations and build targets.
type ExecutionContext = {
    waitUntil: (promise: Promise<unknown>) => void
}

export interface ReplicationConfig {
    /**
     * One or more peer StarbaseDB URLs to replicate writes to.
     * e.g. ["https://replica1.example.workers.dev"]
     */
    replicas: string[]

    /**
     * Authorization token sent with each replication request.
     * Must match the ADMIN_AUTHORIZATION_TOKEN on each replica instance.
     * Prevents unauthorized instances from accepting forwarded writes.
     */
    authToken: string

    /**
     * Optional allowlist of table names to replicate.
     * If omitted, all write operations are replicated.
     * If provided, only mutations to listed tables are forwarded.
     */
    tables?: string[]
}

const MUTATION_TYPES = new Set(['insert', 'update', 'delete', 'replace'])

const parser = new Parser()

/**
 * ReplicationPlugin
 *
 * Intercepts write queries (INSERT, UPDATE, DELETE) via the afterQuery hook
 * and forwards them to one or more peer StarbaseDB instances asynchronously.
 *
 * Unlike the CDC plugin, which captures change events for observability and
 * downstream consumers, this plugin focuses on cross-instance write propagation
 * to keep peer StarbaseDB instances in sync.
 *
 * Replication is implemented via query interception rather than polling,
 * consistent with StarbaseDB's plugin architecture and Cloudflare Worker
 * runtime constraints.
 */
export class ReplicationPlugin extends StarbasePlugin {
    private replicas: string[]
    private tables: Set<string> | null
    private authToken: string

    // ctx is stored via onEvent(), following the CDC plugin pattern.
    // Required to schedule background work via waitUntil without blocking
    // the primary request response.
    private ctx: ExecutionContext | null = null

    constructor(config: ReplicationConfig) {
        // requiresAuth: false because replication runs post-query internally,
        // not as a user-facing route or external request handler.
        super('replication', { requiresAuth: false })
        this.replicas = config.replicas
        this.authToken = config.authToken
        this.tables = config.tables ? new Set(config.tables) : null
    }

    /**
     * Called once at startup with the Worker ExecutionContext.
     * Mirrors the CDC plugin pattern: ctx is injected externally rather
     * than assumed to be present in the afterQuery signature.
     *
     * Usage in src/index.ts:
     *   replicationPlugin.onEvent(ctx)
     */
    onEvent(ctx: ExecutionContext): void {
        this.ctx = ctx
    }

    async register(_app: StarbaseApp): Promise<void> {
        // No HTTP routes needed — this plugin operates purely via query hooks.
    }

    async beforeQuery(opts: {
        sql: string
        params?: unknown[]
        dataSource?: DataSource
        config?: unknown
    }): Promise<{ sql: string; params?: unknown[] }> {
        return { sql: opts.sql, params: opts.params }
    }

    async afterQuery(opts: {
        sql: string
        result: unknown
        isRaw: boolean
        dataSource?: DataSource
        config?: unknown
    }): Promise<unknown> {
        const { sql } = opts

        // Without a stored ctx we cannot schedule background work safely.
        // Degrade gracefully rather than blocking or erroring.
        if (!this.ctx || this.replicas.length === 0) {
            return opts.result
        }

        let statementType: string
        let affectedTable: string | null = null

        try {
            const ast = parser.astify(sql)
            const node = Array.isArray(ast) ? ast[0] : ast
            statementType = (node?.type ?? '').toLowerCase()

            if (statementType === 'insert' || statementType === 'replace') {
                affectedTable =
                    (node as { table?: { table?: string } }).table?.table ??
                    null
            } else if (statementType === 'update') {
                const tables = (
                    node as { table?: Array<{ table?: string }> }
                ).table
                affectedTable = tables?.[0]?.table ?? null
            } else if (statementType === 'delete') {
                const from = (
                    node as { from?: Array<{ table?: string }> }
                ).from
                affectedTable = from?.[0]?.table ?? null
            }
        } catch {
            // Fail-open strategy: if SQL cannot be parsed, skip replication.
            // Replication must never affect primary DB correctness or availability.
            return opts.result
        }

        if (!MUTATION_TYPES.has(statementType)) {
            return opts.result
        }

        // Apply table filter. If filtering is configured and we cannot
        // determine the affected table (parse edge case), skip replication
        // rather than forwarding blindly to unintended replicas.
        if (this.tables !== null) {
            if (!affectedTable || !this.tables.has(affectedTable)) {
                return opts.result
            }
        }

        // Schedule replication in the background via waitUntil so it has
        // zero impact on primary request latency — a hard requirement in
        // Cloudflare Workers where async work outside waitUntil is not
        // guaranteed to complete after the response is sent.
        this.ctx.waitUntil(this.replicateToAll(sql))

        return opts.result
    }

    private async replicateToAll(sql: string): Promise<void> {
        // Promise.allSettled ensures one failing replica never blocks others.
        await Promise.allSettled(
            this.replicas.map((replica) => this.replicateTo(replica, sql))
        )
    }

    private async replicateTo(replicaUrl: string, sql: string): Promise<void> {
        try {
            const endpoint = replicaUrl.replace(/\/$/, '') + '/query'
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${this.authToken}`,
                },
                body: JSON.stringify({ sql, params: [] }),
            })

            if (!response.ok) {
                console.error(
                    `[ReplicationPlugin] Failed to replicate to ${replicaUrl}: HTTP ${response.status}`
                )
            } else {
                console.debug(
                    `[ReplicationPlugin] Replicated to ${replicaUrl}`
                )
            }
        } catch (err) {
            // Log but never throw — a replication failure must not surface
            // to the caller or affect the primary query result.
            console.error(
                `[ReplicationPlugin] Error replicating to ${replicaUrl}:`,
                err
            )
        }
    }
}
