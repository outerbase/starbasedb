import type { DataSyncPluginConfig, TableSyncJob } from './types'

/** Environment / wrangler vars consumed by the data-sync plugin */
export interface DataSyncEnv {
    DATA_SYNC_ENABLED?: string
    /** Seconds — informational; use Worker CRON or CronPlugin to invoke sync */
    DATA_SYNC_INTERVAL_SECONDS?: string
    /**
     * JSON array of TableSyncJob objects.
     * Example:
     * [{"externalTable":"public.users","localTable":"users","cursorKind":"incremental_id","cursorColumn":"id","pkColumns":["id"]}]
     */
    DATA_SYNC_JOBS?: string
    DATA_SYNC_BATCH_SIZE?: string
    DATA_SYNC_MAX_RETRIES?: string
    DATA_SYNC_RETRY_BASE_MS?: string
}

const DEFAULT_BATCH = 250
const DEFAULT_RETRIES = 3
const DEFAULT_RETRY_BASE_MS = 400

function truthy(v: string | undefined): boolean {
    if (!v) return false
    const s = v.toLowerCase().trim()
    return s === '1' || s === 'true' || s === 'yes' || s === 'on'
}

function parseJobsJson(raw: string | undefined): TableSyncJob[] {
    if (!raw?.trim()) return []
    try {
        const parsed = JSON.parse(raw) as unknown
        if (!Array.isArray(parsed)) {
            console.error('[data-sync] DATA_SYNC_JOBS must be a JSON array')
            return []
        }
        const jobs: TableSyncJob[] = []
        for (const item of parsed) {
            if (!item || typeof item !== 'object') continue
            const j = item as Record<string, unknown>
            const externalTable = String(j.externalTable ?? '')
            const localTable = String(
                j.localTable ?? externalTable.split('.').pop() ?? ''
            )
            const cursorKind =
                j.cursorKind === 'timestamp' ? 'timestamp' : 'incremental_id'
            const cursorColumn = String(
                j.cursorColumn ??
                    (cursorKind === 'timestamp' ? 'updated_at' : 'id')
            )
            const pkColumns = Array.isArray(j.pkColumns)
                ? j.pkColumns.map((x) => String(x))
                : j.pkColumns
                  ? [String(j.pkColumns)]
                  : ['id']
            const columnMap =
                j.columnMap && typeof j.columnMap === 'object'
                    ? (j.columnMap as Record<string, string>)
                    : undefined
            if (!externalTable || !localTable) {
                console.warn(
                    '[data-sync] Skipping job with missing externalTable/localTable',
                    item
                )
                continue
            }
            jobs.push({
                externalTable,
                localTable,
                cursorKind,
                cursorColumn,
                pkColumns,
                columnMap,
            })
        }
        return jobs
    } catch (e) {
        console.error('[data-sync] Failed to parse DATA_SYNC_JOBS:', e)
        return []
    }
}

/**
 * Resolve plugin configuration from Worker environment variables.
 * (Wrangler does not pass arbitrary TOML tables into `env`; use `vars` or secrets.)
 */
export function loadDataSyncConfig(env: DataSyncEnv): DataSyncPluginConfig {
    const interval = Number(env.DATA_SYNC_INTERVAL_SECONDS ?? '300')
    return {
        enabled: truthy(env.DATA_SYNC_ENABLED),
        syncIntervalSeconds:
            Number.isFinite(interval) && interval > 0 ? interval : 300,
        jobs: parseJobsJson(env.DATA_SYNC_JOBS),
        batchSize: Math.min(
            1000,
            Math.max(
                1,
                Number(env.DATA_SYNC_BATCH_SIZE ?? DEFAULT_BATCH) ||
                    DEFAULT_BATCH
            )
        ),
        maxRetries: Math.min(
            10,
            Math.max(
                0,
                Number(env.DATA_SYNC_MAX_RETRIES ?? DEFAULT_RETRIES) ||
                    DEFAULT_RETRIES
            )
        ),
        retryBaseMs: Math.min(
            10_000,
            Math.max(
                50,
                Number(env.DATA_SYNC_RETRY_BASE_MS ?? DEFAULT_RETRY_BASE_MS) ||
                    DEFAULT_RETRY_BASE_MS
            )
        ),
    }
}
