import { StarbaseApp, StarbaseDBConfiguration } from '../../src/handler'
import { StarbasePlugin } from '../../src/plugin'
import { DataSource, ExternalDatabaseSource } from '../../src/types'
import { createResponse } from '../../src/utils'
import { executeQuery } from '../../src/operation'
import { CronPlugin } from '../cron'
import { parseCronExpression } from '../cron/utils'

/**
 * Replication plugin — pulls new/changed rows from an external source (Postgres,
 * MySQL) into StarbaseDB's internal SQLite on a schedule, tracking a per-table
 * cursor so each run only fetches what is new (append-only polling).
 *
 * Scheduling is delegated to the Cron plugin: a Durable Object has a single alarm
 * which `src/do.ts` hardcodes to the cron callback, so this plugin registers a cron
 * task per job and runs its sync when that task fires (no alarm collision).
 */

const SQL = {
    CREATE_TABLE: `
        CREATE TABLE IF NOT EXISTS tmp_replication_jobs (
            name TEXT NOT NULL UNIQUE PRIMARY KEY,
            source_config TEXT NOT NULL,
            table_name TEXT NOT NULL,
            tracking_col TEXT NOT NULL,
            tracking_type TEXT NOT NULL DEFAULT 'timestamp',
            last_value TEXT,
            cron_tab TEXT NOT NULL,
            target_table TEXT,
            columns TEXT,
            primary_key TEXT,
            batch_size INTEGER NOT NULL DEFAULT 500,
            is_active INTEGER NOT NULL DEFAULT 1,
            last_run_at TEXT,
            last_error TEXT,
            rows_synced INTEGER NOT NULL DEFAULT 0,
            created_at TEXT DEFAULT (datetime('now')),
            updated_at TEXT DEFAULT (datetime('now'))
        )
    `,
    UPSERT_JOB: `
        INSERT OR REPLACE INTO tmp_replication_jobs
            (name, source_config, table_name, tracking_col, tracking_type,
             last_value, cron_tab, target_table, columns, primary_key,
             batch_size, is_active, last_run_at, last_error, rows_synced,
             created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), datetime('now'))
    `,
    GET_JOB: `SELECT * FROM tmp_replication_jobs WHERE name = ?`,
    GET_JOBS: `SELECT * FROM tmp_replication_jobs`,
    DELETE_JOB: `DELETE FROM tmp_replication_jobs WHERE name = ?`,
    UPDATE_CURSOR: `
        UPDATE tmp_replication_jobs
        SET last_value = ?, rows_synced = ?, updated_at = datetime('now')
        WHERE name = ?
    `,
    UPDATE_RUN_META: `
        UPDATE tmp_replication_jobs
        SET last_run_at = ?, last_error = ?, updated_at = datetime('now')
        WHERE name = ?
    `,
    RESET_CURSOR: `
        UPDATE tmp_replication_jobs
        SET last_value = NULL, rows_synced = 0, updated_at = datetime('now')
        WHERE name = ?
    `,
    SET_ACTIVE: `
        UPDATE tmp_replication_jobs
        SET is_active = ?, updated_at = datetime('now')
        WHERE name = ?
    `,
}

// Identifiers (table / column names) cannot be bound as SQL parameters, so they
// are interpolated. We restrict them to a safe character set and always quote
// them in emitted SQL to defend against injection and to allow reserved words.
const IDENT = /^[A-Za-z0-9_]+$/
const JOB_NAME = /^[A-Za-z0-9_-]+$/

export type TrackingType = 'timestamp' | 'id'

export interface ReplicationJobInput {
    name: string
    source: ExternalDatabaseSource
    table_name: string
    tracking_col: string
    tracking_type?: TrackingType
    cron_tab: string
    target_table?: string
    columns?: string[]
    primary_key?: string[]
    batch_size?: number
}

interface ReplicationJobRow {
    name: string
    source_config: string
    table_name: string
    tracking_col: string
    tracking_type: TrackingType
    last_value: string | null
    cron_tab: string
    target_table: string | null
    columns: string | null
    primary_key: string | null
    batch_size: number
    is_active: number
    last_run_at: string | null
    last_error: string | null
    rows_synced: number
    created_at: string | null
}

// The subset of the Cron plugin this plugin relies on. Declared as an interface
// so the dependency can be trivially mocked in tests.
export interface CronScheduler {
    addEvent(
        cronTab: string,
        name: string,
        payload: Record<string, any>,
        callbackHost: string,
        dataSource?: DataSource
    ): Promise<void>
    removeEvent(name: string, dataSource?: DataSource): Promise<void>
}

export class ReplicationPlugin extends StarbasePlugin {
    public pathPrefix = '/replication'
    private dataSource?: DataSource
    private config?: StarbaseDBConfiguration
    private cron?: CronScheduler
    // Upper bound on pages drained per alarm tick so a single sync can never run
    // unbounded against a Worker's CPU/time budget. The remainder is picked up on
    // the next tick because the cursor is persisted after every page.
    private maxPagesPerRun: number

    constructor(opts?: {
        cron?: CronPlugin | CronScheduler
        maxPagesPerRun?: number
    }) {
        super('starbasedb:replication', { requiresAuth: true })
        this.cron = opts?.cron
        this.maxPagesPerRun = opts?.maxPagesPerRun ?? 50
    }

    override async register(app: StarbaseApp) {
        app.use(async (c, next) => {
            this.dataSource = c?.get('dataSource')
            this.config = c?.get('config')
            await this.init()
            await next()
        })

        app.post(`${this.pathPrefix}/jobs`, (c) => this.handleCreateJob(c))
        app.get(`${this.pathPrefix}/jobs`, (c) => this.handleListJobs(c))
        app.delete(`${this.pathPrefix}/jobs/:name`, (c) =>
            this.handleDeleteJob(c)
        )
        app.post(`${this.pathPrefix}/jobs/:name/run`, (c) =>
            this.handleRunJob(c)
        )
        app.post(`${this.pathPrefix}/jobs/:name/reset`, (c) =>
            this.handleResetJob(c)
        )
        app.patch(`${this.pathPrefix}/jobs/:name`, (c) =>
            this.handlePatchJob(c)
        )
    }

    private async init() {
        if (!this.dataSource) return
        await this.dataSource.rpc.executeQuery({
            sql: SQL.CREATE_TABLE,
            params: [],
        })
    }

    // Replication jobs hold external database credentials and write to the
    // internal database, so every endpoint is restricted to admin callers.
    private requireAdmin(): Response | undefined {
        if (this.config?.role !== 'admin') {
            return new Response('Unauthorized request', { status: 400 })
        }
        return undefined
    }

    // ──────────────────────────────────────────────────────────────────────
    //  Routes
    // ──────────────────────────────────────────────────────────────────────

    private async handleCreateJob(c: any): Promise<Response> {
        const denied = this.requireAdmin()
        if (denied) return denied

        try {
            const body = (await c.req.json()) as ReplicationJobInput
            const job = this.validateJobInput(body)

            // Preserve cursor + counters + created_at across re-creation so
            // re-submitting a job's config does not silently re-replicate.
            const existing = (await this.dataSource!.rpc.executeQuery({
                sql: 'SELECT last_value, rows_synced, created_at FROM tmp_replication_jobs WHERE name = ?',
                params: [job.name],
            })) as unknown as Pick<
                ReplicationJobRow,
                'last_value' | 'rows_synced' | 'created_at'
            >[]
            const prior = existing?.[0]

            await this.dataSource!.rpc.executeQuery({
                sql: SQL.UPSERT_JOB,
                params: [
                    job.name,
                    JSON.stringify(job.source),
                    job.table_name,
                    job.tracking_col,
                    job.tracking_type,
                    prior?.last_value ?? null,
                    job.cron_tab,
                    job.target_table ?? null,
                    job.columns ? JSON.stringify(job.columns) : null,
                    job.primary_key ? JSON.stringify(job.primary_key) : null,
                    job.batch_size,
                    1,
                    null,
                    null,
                    prior?.rows_synced ?? 0,
                    prior?.created_at ?? null,
                ],
            })

            // Register the schedule with the Cron plugin (reuses the DO alarm).
            const origin = new URL(c.req.url).origin
            await this.cron?.addEvent(
                job.cron_tab,
                this.taskName(job.name),
                {},
                origin,
                this.dataSource
            )

            return createResponse(
                { success: true, job: job.name },
                undefined,
                200
            )
        } catch (error: any) {
            return createResponse(
                undefined,
                error?.message ?? 'Failed to create replication job.',
                400
            )
        }
    }

    private async handleListJobs(c: any): Promise<Response> {
        const denied = this.requireAdmin()
        if (denied) return denied

        const jobs = (await this.dataSource!.rpc.executeQuery({
            sql: SQL.GET_JOBS,
            params: [],
        })) as unknown as ReplicationJobRow[]

        // Never expose the source password over the API.
        const sanitized = (jobs ?? []).map((job) => ({
            ...job,
            source_config: redactConfig(job.source_config),
        }))

        return createResponse(sanitized, undefined, 200)
    }

    private async handleDeleteJob(c: any): Promise<Response> {
        const denied = this.requireAdmin()
        if (denied) return denied

        const name = c.req.param('name')
        await this.dataSource!.rpc.executeQuery({
            sql: SQL.DELETE_JOB,
            params: [name],
        })
        await this.cron?.removeEvent(this.taskName(name), this.dataSource)

        return createResponse({ success: true }, undefined, 200)
    }

    private async handleRunJob(c: any): Promise<Response> {
        const denied = this.requireAdmin()
        if (denied) return denied

        const name = c.req.param('name')
        try {
            const result = await this.runSync(name, this.dataSource!)
            return createResponse({ success: true, ...result }, undefined, 200)
        } catch (error: any) {
            return createResponse(
                undefined,
                error?.message ?? 'Replication sync failed.',
                500
            )
        }
    }

    private async handleResetJob(c: any): Promise<Response> {
        const denied = this.requireAdmin()
        if (denied) return denied

        const name = c.req.param('name')
        await this.dataSource!.rpc.executeQuery({
            sql: SQL.RESET_CURSOR,
            params: [name],
        })
        return createResponse({ success: true }, undefined, 200)
    }

    private async handlePatchJob(c: any): Promise<Response> {
        const denied = this.requireAdmin()
        if (denied) return denied

        const name = c.req.param('name')
        const body = (await c.req.json()) as { is_active?: boolean }
        if (typeof body.is_active !== 'boolean') {
            return createResponse(
                undefined,
                'Body must include a boolean "is_active".',
                400
            )
        }
        await this.dataSource!.rpc.executeQuery({
            sql: SQL.SET_ACTIVE,
            params: [body.is_active ? 1 : 0, name],
        })
        return createResponse({ success: true }, undefined, 200)
    }

    // ──────────────────────────────────────────────────────────────────────
    //  Cron event → sync
    // ──────────────────────────────────────────────────────────────────────

    /**
     * Invoked for every cron task that fires. The cron payload arrives as a JSON
     * string at runtime, so we route purely by task name (`replication:<job>`).
     * The `dataSource` is passed in from the request scope because the cron
     * callback runs on a separate request where this plugin's middleware has not
     * captured one.
     */
    public async handleCronEvent(
        event: { name?: string },
        dataSource: DataSource
    ): Promise<void> {
        const name = event?.name
        if (!name || !name.startsWith('replication:')) return
        const jobName = name.slice('replication:'.length)
        try {
            await this.runSync(jobName, dataSource)
        } catch (error) {
            console.error(`Replication sync failed for "${jobName}":`, error)
        }
    }

    /**
     * Pull all rows newer than the stored cursor for a single job and upsert them
     * into the internal database, advancing the cursor as it goes. Errors are
     * captured on the job row so one failing job never breaks the others.
     */
    public async runSync(
        name: string,
        dataSource: DataSource
    ): Promise<{ rowsSynced: number; pages: number }> {
        const jobs = (await dataSource.rpc.executeQuery({
            sql: SQL.GET_JOB,
            params: [name],
        })) as unknown as ReplicationJobRow[]
        const job = jobs?.[0]
        if (!job) return { rowsSynced: 0, pages: 0 }
        if (job.is_active !== 1) return { rowsSynced: 0, pages: 0 } // paused

        const external = JSON.parse(job.source_config) as ExternalDatabaseSource
        const dialect = external.dialect
        const externalDS: DataSource = {
            rpc: dataSource.rpc,
            source: 'external',
            external,
            executionContext: dataSource.executionContext,
        }

        // Bypass RLS / allowlist / cache for the external pull. On the cron
        // callback path the request role is `client`, which would otherwise apply
        // internal RLS policies to the external query and mangle the SQL.
        const pullConfig = {
            role: 'admin',
            features: { rls: false, allowlist: false },
        } as StarbaseDBConfiguration

        const targetTable = job.target_table ?? job.table_name
        const selectCols = parseJSONArray(job.columns)
        const primaryKey = parseJSONArray(job.primary_key)
        const batch = clampBatch(job.batch_size)

        let cursor = job.last_value
        let totalSynced = job.rows_synced ?? 0
        let pages = 0
        let runError: string | null = null

        try {
            for (let page = 0; page < this.maxPagesPerRun; page++) {
                const sql = buildPullQuery(
                    job.table_name,
                    job.tracking_col,
                    selectCols,
                    cursor != null,
                    batch,
                    dialect
                )
                const params = cursor != null ? [cursor] : []

                const result = await executeQuery({
                    sql,
                    params,
                    isRaw: true,
                    dataSource: externalDS,
                    config: pullConfig,
                })
                const rows = toRowObjects(result)
                if (rows.length === 0) break

                await this.applyRows(dataSource, targetTable, primaryKey, rows)

                const nextCursor = advanceCursor(
                    cursor,
                    rows,
                    job.tracking_col,
                    job.tracking_type
                )
                const advanced = nextCursor !== cursor
                cursor = nextCursor
                totalSynced += rows.length
                pages++

                // Persist progress after each page so a mid-run interruption
                // resumes from the last completed page rather than restarting.
                await dataSource.rpc.executeQuery({
                    sql: SQL.UPDATE_CURSOR,
                    params: [cursor, totalSynced, name],
                })

                // Stop if the cursor cannot move forward (e.g. the tracking
                // column is entirely NULL on this page) to avoid re-fetching the
                // same page until maxPagesPerRun.
                if (!advanced) break
                if (rows.length < batch) break // last page
            }
        } catch (error: any) {
            // Never let the source password surface in a stored or returned
            // error (driver errors can echo the connection details).
            runError = redactSecrets(error?.message ?? String(error), external)
            throw new Error(runError)
        } finally {
            await dataSource.rpc.executeQuery({
                sql: SQL.UPDATE_RUN_META,
                params: [new Date().toISOString(), runError, name],
            })
        }

        return { rowsSynced: totalSynced - (job.rows_synced ?? 0), pages }
    }

    /**
     * Ensure the destination table exists (inferring column types from the first
     * row) and upsert the page of rows in chunked multi-row statements.
     */
    private async applyRows(
        dataSource: DataSource,
        targetTable: string,
        primaryKey: string[] | null,
        rows: Record<string, unknown>[]
    ): Promise<void> {
        const cols = Object.keys(rows[0])
        if (cols.length === 0) return

        await this.ensureTable(dataSource, targetTable, rows, primaryKey)

        const colList = cols.map((col) => `"${col}"`).join(', ')
        // SQLite caps bound variables per statement (default 999). Chunk rows so
        // cols * rowsPerChunk stays comfortably under that limit.
        const rowsPerChunk = Math.max(1, Math.floor(900 / cols.length))

        for (let i = 0; i < rows.length; i += rowsPerChunk) {
            const chunk = rows.slice(i, i + rowsPerChunk)
            const tuple = `(${cols.map(() => '?').join(', ')})`
            const placeholders = chunk.map(() => tuple).join(', ')
            const params: unknown[] = []
            for (const row of chunk) {
                for (const col of cols) params.push(serializeValue(row[col]))
            }

            await dataSource.rpc.executeQuery({
                sql: `INSERT OR REPLACE INTO "${targetTable}" (${colList}) VALUES ${placeholders}`,
                params,
            })
        }
    }

    private async ensureTable(
        dataSource: DataSource,
        targetTable: string,
        rows: Record<string, unknown>[],
        primaryKey: string[] | null
    ): Promise<void> {
        const defs = Object.keys(rows[0]).map((col) => {
            // Infer from the first non-null value across the page so a NULL in
            // the first row does not force an otherwise-typed column to TEXT.
            const sample = rows.find(
                (row) => row[col] !== null && row[col] !== undefined
            )?.[col]
            return `"${col}" ${inferSqliteType(sample)}`
        })
        const pkClause =
            primaryKey && primaryKey.length
                ? `, PRIMARY KEY (${primaryKey.map((c) => `"${c}"`).join(', ')})`
                : ''

        await dataSource.rpc.executeQuery({
            sql: `CREATE TABLE IF NOT EXISTS "${targetTable}" (${defs.join(', ')}${pkClause})`,
            params: [],
        })
    }

    private taskName(jobName: string): string {
        return `replication:${jobName}`
    }

    // ──────────────────────────────────────────────────────────────────────
    //  Validation
    // ──────────────────────────────────────────────────────────────────────

    private validateJobInput(body: ReplicationJobInput): Required<
        Pick<
            ReplicationJobInput,
            | 'name'
            | 'table_name'
            | 'tracking_col'
            | 'tracking_type'
            | 'cron_tab'
            | 'batch_size'
        >
    > & {
        source: ExternalDatabaseSource
        target_table?: string
        columns?: string[]
        primary_key?: string[]
    } {
        if (!body || typeof body !== 'object') {
            throw new Error('Request body is required.')
        }

        const name = body.name
        if (!name || !JOB_NAME.test(name)) {
            throw new Error(
                'A "name" of letters, numbers, underscores or hyphens is required.'
            )
        }

        assertIdent(body.table_name, 'table_name')
        assertIdent(body.tracking_col, 'tracking_col')

        const tracking_type = body.tracking_type ?? 'timestamp'
        if (tracking_type !== 'timestamp' && tracking_type !== 'id') {
            throw new Error('"tracking_type" must be "timestamp" or "id".')
        }

        if (!body.cron_tab || typeof body.cron_tab !== 'string') {
            throw new Error('A "cron_tab" schedule is required.')
        }
        try {
            parseCronExpression(body.cron_tab)
        } catch {
            throw new Error(`Invalid cron expression: "${body.cron_tab}".`)
        }

        validateSource(body.source)

        if (body.target_table !== undefined) {
            assertIdent(body.target_table, 'target_table')
        }
        if (body.columns !== undefined) {
            if (!Array.isArray(body.columns) || body.columns.length === 0) {
                throw new Error('"columns" must be a non-empty array.')
            }
            body.columns.forEach((col) => assertIdent(col, 'columns'))
        }
        if (body.primary_key !== undefined) {
            if (
                !Array.isArray(body.primary_key) ||
                body.primary_key.length === 0
            ) {
                throw new Error('"primary_key" must be a non-empty array.')
            }
            body.primary_key.forEach((col) => assertIdent(col, 'primary_key'))
        }

        // When an explicit column list is given it must cover the tracking
        // column (otherwise the cursor can never advance) and every primary-key
        // column (otherwise CREATE TABLE references a column that isn't pulled).
        if (body.columns) {
            if (!body.columns.includes(body.tracking_col)) {
                throw new Error(
                    'When "columns" is set it must include the "tracking_col".'
                )
            }
            if (
                body.primary_key &&
                !body.primary_key.every((col) => body.columns!.includes(col))
            ) {
                throw new Error(
                    'When "columns" is set it must include every "primary_key" column.'
                )
            }
        }

        return {
            name,
            source: body.source,
            table_name: body.table_name,
            tracking_col: body.tracking_col,
            tracking_type,
            cron_tab: body.cron_tab,
            target_table: body.target_table,
            columns: body.columns,
            primary_key: body.primary_key,
            batch_size: clampBatch(body.batch_size),
        }
    }
}

// ──────────────────────────────────────────────────────────────────────────
//  Pure helpers (exported for unit testing)
// ──────────────────────────────────────────────────────────────────────────

export function assertIdent(value: unknown, label: string): void {
    if (typeof value !== 'string' || !IDENT.test(value)) {
        throw new Error(
            `Invalid ${label}: "${String(value)}". Only letters, numbers and underscores are allowed.`
        )
    }
}

export function quoteIdent(name: string, dialect: string): string {
    return dialect === 'mysql' ? `\`${name}\`` : `"${name}"`
}

export function clampBatch(value: unknown): number {
    const n = Number(value)
    if (!Number.isFinite(n) || n <= 0) return 500
    return Math.min(10000, Math.max(1, Math.floor(n)))
}

export function buildPullQuery(
    table: string,
    trackingCol: string,
    columns: string[] | null,
    hasCursor: boolean,
    batch: number,
    dialect: string
): string {
    const cols =
        columns && columns.length
            ? columns.map((col) => quoteIdent(col, dialect)).join(', ')
            : '*'
    const where = hasCursor
        ? `WHERE ${quoteIdent(trackingCol, dialect)} > ? `
        : ''
    return (
        `SELECT ${cols} FROM ${quoteIdent(table, dialect)} ` +
        `${where}ORDER BY ${quoteIdent(trackingCol, dialect)} ASC LIMIT ${batch}`
    )
}

export function toRowObjects(result: any): Record<string, unknown>[] {
    if (!result) return []
    // Mocked / non-raw paths may already return an array of row objects.
    if (Array.isArray(result)) return result as Record<string, unknown>[]
    const columns: string[] = result.columns ?? []
    const rows: unknown[][] = result.rows ?? []
    return rows.map((row) =>
        columns.reduce((obj: Record<string, unknown>, col, index) => {
            obj[col] = row[index]
            return obj
        }, {})
    )
}

/**
 * Compute the new cursor as the maximum tracking value seen. The comparison is
 * type-aware: numeric for `id` (so '10' > '9'), temporal for `timestamp`
 * (falling back to lexical order for ISO-8601 strings). NULLs are skipped.
 */
export function advanceCursor(
    previous: string | null,
    rows: Record<string, unknown>[],
    trackingCol: string,
    trackingType: TrackingType
): string | null {
    let max = previous
    for (const row of rows) {
        const raw = row[trackingCol]
        if (raw === null || raw === undefined) continue
        const value = raw instanceof Date ? raw.toISOString() : String(raw)
        if (max === null) {
            max = value
            continue
        }
        if (greaterThan(value, max, trackingType)) max = value
    }
    return max
}

function greaterThan(a: string, b: string, type: TrackingType): boolean {
    if (type === 'id') {
        const na = Number(a)
        const nb = Number(b)
        if (!Number.isNaN(na) && !Number.isNaN(nb)) return na > nb
        return a > b
    }
    const ta = Date.parse(a)
    const tb = Date.parse(b)
    if (!Number.isNaN(ta) && !Number.isNaN(tb)) return ta > tb
    return a > b
}

export function inferSqliteType(value: unknown): string {
    if (typeof value === 'number') {
        return Number.isInteger(value) ? 'INTEGER' : 'REAL'
    }
    if (typeof value === 'boolean') return 'INTEGER'
    if (typeof value === 'bigint') return 'INTEGER'
    return 'TEXT'
}

export function serializeValue(value: unknown): unknown {
    if (value === null || value === undefined) return null
    if (typeof value === 'boolean') return value ? 1 : 0
    if (typeof value === 'number') {
        // SQLite has no NaN / Infinity storage class.
        return Number.isFinite(value) ? value : null
    }
    if (typeof value === 'bigint') {
        // Cloudflare's SqlStorage binds number/string/null — not bigint — so
        // narrow to a number when it fits, otherwise keep full precision as text.
        return value >= BigInt(Number.MIN_SAFE_INTEGER) &&
            value <= BigInt(Number.MAX_SAFE_INTEGER)
            ? Number(value)
            : String(value)
    }
    if (value instanceof Date) return value.toISOString()
    if (typeof value === 'object') return JSON.stringify(value)
    return value
}

export function parseJSONArray(value: string | null): string[] | null {
    if (!value) return null
    try {
        const parsed = JSON.parse(value)
        return Array.isArray(parsed) ? parsed : null
    } catch {
        return null
    }
}

export function redactSecrets(
    message: string,
    source: ExternalDatabaseSource
): string {
    const secret = (source as { password?: string })?.password
    if (!secret) return message
    return message.split(secret).join('***')
}

export function redactConfig(sourceConfig: string): string {
    try {
        const parsed = JSON.parse(sourceConfig)
        if (parsed && typeof parsed === 'object' && 'password' in parsed) {
            parsed.password = '***'
        }
        return JSON.stringify(parsed)
    } catch {
        return sourceConfig
    }
}

function validateSource(source: any): void {
    if (!source || typeof source !== 'object') {
        throw new Error('A "source" connection object is required.')
    }
    if (source.dialect !== 'postgresql' && source.dialect !== 'mysql') {
        throw new Error(
            'source.dialect must be "postgresql" or "mysql" for replication.'
        )
    }
    for (const field of ['host', 'port', 'user', 'password', 'database']) {
        if (source[field] === undefined || source[field] === null) {
            throw new Error(`source.${field} is required.`)
        }
    }
}
