/**
 * Configuration for a single table to replicate.
 */
export interface SyncTableConfig {
    /** Name of the table in the external source */
    sourceTable: string
    /** Optional schema in the external source (e.g. "public" for Postgres) */
    sourceSchema?: string
    /**
     * Column used to track incremental changes (e.g. "updated_at", "id").
     * If omitted the plugin does a full table replacement on each sync cycle.
     */
    cursorColumn?: string
    /**
     * Optional name override for the table in the internal SQLite store.
     * Defaults to `${sourceSchema}_${sourceTable}` when a schema is present,
     * or simply `${sourceTable}` otherwise.
     */
    targetTable?: string
}

/**
 * Metadata tracked per replicated table.
 */
export interface SyncMetadata {
    tableName: string
    lastCursorValue: string | null
    lastSyncedAt: string
    rowsSynced: number
}

/**
 * The shape every adapter must return from `fetchRows`.
 */
export interface FetchResult {
    columns: ColumnDefinition[]
    rows: Record<string, unknown>[]
}

/**
 * Column metadata returned by an adapter's schema introspection.
 */
export interface ColumnDefinition {
    name: string
    /** The source-native type (e.g. "integer", "varchar(255)", "timestamptz") */
    sourceType: string
}

/**
 * Top-level configuration object for the DataSyncPlugin.
 */
export interface DataSyncConfig {
    /** Tables to replicate */
    tables: SyncTableConfig[]
    /**
     * Sync interval in milliseconds.
     * Defaults to 60_000 (1 minute).
     */
    intervalMs?: number
    /**
     * Maximum number of rows to fetch per batch from the external source.
     * Defaults to 1000.
     */
    batchSize?: number
}
