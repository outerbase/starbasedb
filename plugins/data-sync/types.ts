/**
 * Data Sync Plugin — shared types (Issue #72)
 */

/** How we page through the upstream table */
export type CursorKind = 'incremental_id' | 'timestamp'

export interface TableSyncJob {
    /** Qualified or bare table on the external engine, e.g. "public.users" or "users" */
    externalTable: string
    /** Destination SQLite table inside the Durable Object */
    localTable: string
    cursorKind: CursorKind
    /** Column used for incremental pull (e.g. "id", "updated_at") */
    cursorColumn: string
    /** Primary key column(s) in SQLite for idempotent UPSERT */
    pkColumns: string[]
    /** Optional explicit column map: external_col -> sqlite_col */
    columnMap?: Record<string, string>
}

export interface DataSyncPluginConfig {
    enabled: boolean
    /** Suggested interval for external CRON / CronPlugin (seconds) */
    syncIntervalSeconds: number
    jobs: TableSyncJob[]
    batchSize: number
    maxRetries: number
    retryBaseMs: number
}

export type SyncStatusState = 'idle' | 'running' | 'ok' | 'error' | 'partial'

export interface TableSyncMetaRow {
    table_name: string
    last_synced_at: string | null
    last_cursor_id: string | null
    last_cursor_ts: string | null
    sync_status: SyncStatusState
    error_message: string | null
    rows_last_run: number
    updated_at: string | null
}

export interface SyncLogEntry {
    id?: number
    level: 'info' | 'warn' | 'error'
    scope: string
    message: string
    created_at?: string
}

export interface TableSyncResult {
    job: TableSyncJob
    rowsFetched: number
    rowsWritten: number
    error?: string
}

export interface SyncRunSummary {
    startedAt: string
    finishedAt: string
    results: TableSyncResult[]
    overallStatus: SyncStatusState
}
