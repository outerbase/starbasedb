export type CursorType = 'integer' | 'timestamp'
export type ConflictStrategy = 'replace' | 'ignore'
export type SyncStatus = 'idle' | 'running' | 'success' | 'error'

export interface TableReplicationConfig {
    sourceTable: string
    targetTable?: string
    schema?: string
    cursorColumn: string
    cursorType: CursorType
    columns?: string[]
    conflictStrategy?: ConflictStrategy
}

export interface ReplicationConfig {
    tables: TableReplicationConfig[]
    batchSize?: number
    syncIntervalMs?: number
    cronSchedule?: string
    callbackHost?: string
}

export interface ReplicationState {
    source_table: string
    target_table: string
    last_cursor_value: string | null
    last_sync_at: string | null
    rows_synced: number
    total_rows_synced: number
    status: SyncStatus
    error_message: string | null
    updated_at: string
}

export interface SyncResult {
    table: string
    rowsSynced: number
    durationMs: number
    success: boolean
    error?: string
}
