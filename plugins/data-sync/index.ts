/**
 * Data Sync Plugin — pull-based incremental sync from external RDBMS into StarbaseDB SQLite (DO).
 * @see https://github.com/gittare/starbasedb — Issue #72
 */
import { StarbaseApp, StarbaseDBConfiguration } from '../../src/handler'
import { StarbasePlugin } from '../../src/plugin'
import { createResponse } from '../../src/utils'
import type { DataSource } from '../../src/types'
import { loadDataSyncConfig, type DataSyncEnv } from './config'
import { createExternalReadAdapter } from './adapter'
import { ensureDataSyncTables, runFullSync } from './sync-engine'
import type { TableSyncJob } from './types'

function getSqlDialect(
    dataSource: DataSource
): 'postgresql' | 'mysql' | 'none' {
    const ext = dataSource.external
    if (!ext) return 'none'
    if (ext.dialect === 'postgresql') return 'postgresql'
    if (ext.dialect === 'mysql') return 'mysql'
    return 'none'
}

export class DataSyncPlugin extends StarbasePlugin {
    pathPrefix = '/data-sync'
    private dataSource?: DataSource
    private honoConfig?: StarbaseDBConfiguration
    private readonly workerEnv: DataSyncEnv

    constructor(workerEnv: DataSyncEnv) {
        super('starbasedb:data-sync', { requiresAuth: true })
        this.workerEnv = workerEnv
    }

    private requireAdmin() {
        if (this.honoConfig?.role !== 'admin') {
            return createResponse(
                undefined,
                'Admin authorization required for data-sync routes.',
                403
            )
        }
        return null
    }

    override async register(app: StarbaseApp) {
        app.use(async (c, next) => {
            this.dataSource = c.get('dataSource')
            this.honoConfig = c.get('config')
            await next()
        })

        /** GET /data-sync/sync-status — metadata + recent log lines */
        app.get(`${this.pathPrefix}/sync-status`, async () => {
            const denied = this.requireAdmin()
            if (denied) return denied
            if (!this.dataSource) {
                return createResponse(
                    undefined,
                    'Data source not initialized',
                    500
                )
            }

            const pluginConfig = loadDataSyncConfig(this.workerEnv)
            await ensureDataSyncTables(this.dataSource.rpc)

            const meta = (await this.dataSource.rpc.executeQuery({
                sql: `SELECT * FROM tmp_data_sync_meta ORDER BY table_name`,
                params: [],
            })) as Record<string, unknown>[]

            const logs = (await this.dataSource.rpc.executeQuery({
                sql: `SELECT id, level, scope, message, created_at FROM tmp_data_sync_log ORDER BY id DESC LIMIT 100`,
                params: [],
            })) as Record<string, unknown>[]

            return createResponse(
                {
                    enabled: pluginConfig.enabled,
                    syncIntervalSeconds: pluginConfig.syncIntervalSeconds,
                    jobCount: pluginConfig.jobs.length,
                    meta,
                    logs,
                },
                undefined,
                200
            )
        })

        /** POST /data-sync/sync-data — run pull sync (optional body: { "tables": ["local_table_name"] }) */
        app.post(`${this.pathPrefix}/sync-data`, async (c) => {
            const denied = this.requireAdmin()
            if (denied) return denied
            if (!this.dataSource || !this.honoConfig) {
                return createResponse(
                    undefined,
                    'Data source not initialized',
                    500
                )
            }

            const pluginConfig = loadDataSyncConfig(this.workerEnv)
            if (!pluginConfig.enabled) {
                return createResponse(
                    { ok: false, message: 'DATA_SYNC_ENABLED is not set' },
                    undefined,
                    400
                )
            }

            if (!pluginConfig.jobs.length) {
                return createResponse(
                    {
                        ok: false,
                        message: 'No jobs configured (DATA_SYNC_JOBS)',
                    },
                    undefined,
                    400
                )
            }

            let filter: string[] | undefined
            try {
                const body = await c.req.json().catch(() => ({}))
                if (body && Array.isArray(body.tables)) {
                    filter = body.tables.map((t: unknown) => String(t))
                }
            } catch {
                filter = undefined
            }

            let jobs: TableSyncJob[] = pluginConfig.jobs
            if (filter?.length) {
                jobs = jobs.filter((j) => filter!.includes(j.localTable))
                if (!jobs.length) {
                    return createResponse(
                        {
                            ok: false,
                            message: 'No jobs matched the tables filter',
                        },
                        undefined,
                        400
                    )
                }
            }

            const dialect = getSqlDialect(this.dataSource)
            const adapter = createExternalReadAdapter(
                this.dataSource,
                this.honoConfig,
                this.dataSource.executionContext
            )

            const summary = await runFullSync({
                jobs,
                adapter,
                dataSource: this.dataSource,
                pluginConfig,
                dialect,
            })

            return createResponse(
                { ok: summary.overallStatus !== 'error', summary },
                undefined,
                200
            )
        })

        /** GET /data-sync/debug — redacted config + connectivity probe */
        app.get(`${this.pathPrefix}/debug`, async () => {
            const denied = this.requireAdmin()
            if (denied) return denied
            if (!this.dataSource || !this.honoConfig) {
                return createResponse(
                    undefined,
                    'Data source not initialized',
                    500
                )
            }

            const pluginConfig = loadDataSyncConfig(this.workerEnv)
            const dialect = getSqlDialect(this.dataSource)
            const adapter = createExternalReadAdapter(
                this.dataSource,
                this.honoConfig
            )

            let probe: { ok: boolean; message?: string } = {
                ok: false,
                message: 'no adapter',
            }
            if (adapter) {
                try {
                    const rows = await adapter.query<{ one: number }>(
                        dialect === 'mysql'
                            ? 'SELECT 1 AS one'
                            : 'SELECT 1 AS one'
                    )
                    probe = { ok: rows.length > 0, message: 'SELECT 1 ok' }
                } catch (e) {
                    probe = {
                        ok: false,
                        message: e instanceof Error ? e.message : String(e),
                    }
                }
            }

            const ext = this.dataSource.external
            const redactedExternal = ext
                ? {
                      dialect: ext.dialect,
                      host: 'host' in ext ? ext.host : undefined,
                      port: 'port' in ext ? ext.port : undefined,
                      database: 'database' in ext ? ext.database : undefined,
                      hasConnectionString:
                          'connectionString' in ext && !!ext.connectionString,
                  }
                : null

            return createResponse(
                {
                    plugin: 'starbasedb:data-sync',
                    enabled: pluginConfig.enabled,
                    dialect,
                    batchSize: pluginConfig.batchSize,
                    jobsPreview: pluginConfig.jobs.map((j) => ({
                        externalTable: j.externalTable,
                        localTable: j.localTable,
                        cursorKind: j.cursorKind,
                        cursorColumn: j.cursorColumn,
                    })),
                    external: redactedExternal,
                    probe,
                },
                undefined,
                200
            )
        })
    }
}

export { loadDataSyncConfig } from './config'
export type { DataSyncEnv } from './config'
export type * from './types'
export { createExternalReadAdapter } from './adapter'
export {
    ensureDataSyncTables,
    runFullSync,
    mapValueForSqlite,
    buildBatchUpsert,
    assertSqliteIdent,
} from './sync-engine'
