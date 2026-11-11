import { StarbaseApp, StarbaseDBConfiguration } from '../../src/handler'
import { StarbasePlugin } from '../../src/plugin'
import { DataSource } from '../../src/types'

export interface ReplicationTableSpec {
    table: string
    primaryKey: string
    watermarkColumn?: string
    batchSize?: number
}

export interface ExternalReplicationConfig {
    externalDataSource: DataSource
    internalDataSource: DataSource
    tables: ReplicationTableSpec[]
    config?: StarbaseDBConfiguration
}

function inferSqliteColumnType(val: any): string {
    if (typeof val === 'number') {
        return Number.isInteger(val) ? 'INTEGER' : 'REAL'
    }
    if (typeof val === 'boolean') {
        return 'INTEGER'
    }
    return 'TEXT'
}

export class ExternalReplicationPlugin extends StarbasePlugin {
    public prefix: string = '/replicator'
    private replicationConfig: ExternalReplicationConfig
    private watermarks: Record<string, string | number> = {}

    constructor(replicationConfig: ExternalReplicationConfig) {
        super('starbasedb:external-replicator', {
            requiresAuth: true,
        })
        this.replicationConfig = replicationConfig
    }

    public async syncTable(spec: ReplicationTableSpec): Promise<{
        table: string
        rowsSynced: number
        lastWatermark: string | number | null
    }> {
        const { externalDataSource, internalDataSource } = this.replicationConfig
        const batchSize = Math.max(1, spec.batchSize ?? 500)
        const lastWatermark = this.watermarks[spec.table] ?? null

        let pullSql = `SELECT * FROM "${spec.table.replace(/"/g, '""')}"`
        const params: any[] = []
        if (spec.watermarkColumn && lastWatermark !== null) {
            pullSql += ` WHERE "${spec.watermarkColumn.replace(/"/g, '""')}" > ?`
            params.push(lastWatermark)
        }
        if (spec.watermarkColumn) {
            pullSql += ` ORDER BY "${spec.watermarkColumn.replace(/"/g, '""')}" ASC`
        }
        pullSql += ` LIMIT ${batchSize};`

        const extRes: any = await externalDataSource.query({ sql: pullSql, params })
        const rows: Record<string, any>[] = extRes?.rows ?? (Array.isArray(extRes) ? extRes : [])

        if (rows.length === 0) {
            return { table: spec.table, rowsSynced: 0, lastWatermark }
        }

        const sample = rows[0]
        const columns = Object.keys(sample)
        const colDefs = columns.map((col) => {
            const colType = inferSqliteColumnType(sample[col])
            const pk = col === spec.primaryKey ? ' PRIMARY KEY' : ''
            return `"${col.replace(/"/g, '""')}" ${colType}${pk}`
        })

        await internalDataSource.query({
            sql: `CREATE TABLE IF NOT EXISTS "${spec.table.replace(/"/g, '""')}" (${colDefs.join(', ')});`,
            params: [],
        })

        let newestWatermark = lastWatermark
        for (const row of rows) {
            const placeholders = columns.map(() => '?').join(', ')
            const colNames = columns.map((c) => `"${c.replace(/"/g, '""')}"`).join(', ')
            const values = columns.map((c) => row[c])
            await internalDataSource.query({
                sql: `INSERT OR REPLACE INTO "${spec.table.replace(/"/g, '""')}" (${colNames}) VALUES (${placeholders});`,
                params: values,
            })
            if (spec.watermarkColumn && row[spec.watermarkColumn] !== undefined) {
                newestWatermark = row[spec.watermarkColumn]
            }
        }

        if (newestWatermark !== null) {
            this.watermarks[spec.table] = newestWatermark
        }

        return {
            table: spec.table,
            rowsSynced: rows.length,
            lastWatermark: newestWatermark,
        }
    }

    public async syncAll(): Promise<{
        syncedAt: string
        tables: Array<{ table: string; rowsSynced: number; lastWatermark: string | number | null }>
    }> {
        const results = []
        for (const spec of this.replicationConfig.tables) {
            results.push(await this.syncTable(spec))
        }
        return {
            syncedAt: new Date().toISOString(),
            tables: results,
        }
    }

    override async register(app: StarbaseApp) {
        app.post(`${this.prefix}/sync`, async () => {
            const summary = await this.syncAll()
            return new Response(JSON.stringify(summary), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            })
        })
    }
}
