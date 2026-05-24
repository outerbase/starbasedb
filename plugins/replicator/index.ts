import { StarbaseApp, StarbaseDBConfiguration } from '../../src/handler'
import { StarbasePlugin } from '../../src/plugin'
import { executeSDKQuery } from '../../src/operation'
import { DataSource, ExternalDatabaseSource } from '../../src/types'
import { createResponse } from '../../src/utils'

// Conservative identifier guard: bare letters, digits and underscores only.
// Anything else (spaces, hyphens, quotes, reserved characters) is rejected at
// construction time so we never have to inject untrusted identifiers into SQL.
const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

function validateIdentifier(value: string, label: string) {
    if (!IDENTIFIER_PATTERN.test(value)) {
        throw new Error(
            `Invalid ${label} "${value}". Only [A-Za-z0-9_] identifiers starting with a letter or underscore are supported.`
        )
    }
}

function quoteExternalIdentifier(
    name: string,
    dialect: ExternalDatabaseSource['dialect']
): string {
    // MySQL uses backticks; postgresql / sqlite use double quotes. Identifiers
    // are validated at construction time so the value here is always safe.
    return dialect === 'mysql' ? `\`${name}\`` : `"${name}"`
}

const SQL_QUERIES = {
    CREATE_STATE_TABLE: `
        CREATE TABLE IF NOT EXISTS tmp_replication_state (
            table_name TEXT NOT NULL PRIMARY KEY,
            last_value TEXT,
            last_synced_at DATETIME
        )
    `,
    GET_LAST_VALUE: `
        SELECT last_value FROM tmp_replication_state WHERE table_name = ?
    `,
    UPSERT_STATE: `
        INSERT INTO tmp_replication_state (table_name, last_value, last_synced_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(table_name) DO UPDATE SET
            last_value = excluded.last_value,
            last_synced_at = CURRENT_TIMESTAMP
    `,
    GET_ALL_STATE: `
        SELECT table_name, last_value, last_synced_at FROM tmp_replication_state
    `,
}

export interface ReplicationTable {
    // Name of the table in the external source
    name: string
    // Column used to track replication progress (e.g. updated_at, id)
    watermarkColumn: string
    // Primary key column used to upsert rows into the internal table
    primaryKey: string
    // Optional name for the destination table inside StarbaseDB
    destTable?: string
}

export interface ReplicationResult {
    table: string
    rowsReplicated: number
    lastValue: string | null
}

export class ReplicatorPlugin extends StarbasePlugin {
    public pathPrefix: string = '/replicator'
    private dataSource?: DataSource
    private external: ExternalDatabaseSource
    private tables: ReplicationTable[]
    private batchSize: number
    private config?: StarbaseDBConfiguration

    constructor(opts: {
        external: ExternalDatabaseSource
        tables: ReplicationTable[]
        batchSize?: number
        pathPrefix?: string
    }) {
        super('starbasedb:replicator', {
            requiresAuth: true,
        })

        if (!opts?.external) {
            throw new Error(
                'An external source is required for the Replicator plugin.'
            )
        }

        if (!opts?.tables?.length) {
            throw new Error(
                'At least one table must be configured for the Replicator plugin.'
            )
        }

        for (const table of opts.tables) {
            if (!table.name || !table.watermarkColumn || !table.primaryKey) {
                throw new Error(
                    'Each replication table requires name, watermarkColumn and primaryKey.'
                )
            }
            validateIdentifier(table.name, 'table name')
            validateIdentifier(table.watermarkColumn, 'watermarkColumn')
            validateIdentifier(table.primaryKey, 'primaryKey')
            if (table.destTable) {
                validateIdentifier(table.destTable, 'destTable')
            }
        }

        this.external = opts.external
        this.tables = opts.tables
        this.batchSize = opts.batchSize ?? 1000
        if (opts.pathPrefix) this.pathPrefix = opts.pathPrefix
    }

    override async register(app: StarbaseApp) {
        app.use(async (c, next) => {
            this.dataSource = c?.get('dataSource')
            this.config = c?.get('config')
            await this.init()
            await next()
        })

        app.post(`${this.pathPrefix}/sync`, async (c) => {
            // Only admin authorized users may trigger replication.
            if (this.config?.role !== 'admin') {
                return createResponse(undefined, 'Unauthorized request', 401)
            }

            try {
                const results = await this.sync()
                return createResponse(
                    { success: true, results },
                    undefined,
                    200
                )
            } catch (error: unknown) {
                console.error('Replication error:', error)
                const message =
                    error instanceof Error ? error.message : String(error)
                return createResponse(
                    undefined,
                    `Replication failed: ${message}`,
                    500
                )
            }
        })
    }

    private async init() {
        if (!this.dataSource) return

        await this.dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.CREATE_STATE_TABLE,
            params: [],
        })
    }

    /**
     * Run a replication pass across every configured table. Each table is
     * pulled in order, using the stored watermark to fetch only the rows
     * that have changed since the previous run.
     */
    public async sync(): Promise<ReplicationResult[]> {
        const dataSource = this.dataSource
        if (!dataSource) {
            throw new Error('ReplicatorPlugin not properly initialized')
        }

        const results: ReplicationResult[] = []
        for (const table of this.tables) {
            results.push(await this.syncTable(dataSource, table))
        }
        return results
    }

    private async getLastValue(
        dataSource: DataSource,
        tableName: string
    ): Promise<string | null> {
        const rows = (await dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.GET_LAST_VALUE,
            params: [tableName],
        })) as Array<{ last_value: string | null }>

        return rows?.[0]?.last_value ?? null
    }

    private async setLastValue(
        dataSource: DataSource,
        tableName: string,
        lastValue: string
    ) {
        await dataSource.rpc.executeQuery({
            sql: SQL_QUERIES.UPSERT_STATE,
            params: [tableName, lastValue],
        })
    }

    private async syncTable(
        dataSource: DataSource,
        table: ReplicationTable
    ): Promise<ReplicationResult> {
        const lastValue = await this.getLastValue(dataSource, table.name)
        const destTable = table.destTable ?? table.name
        const quotedSource = quoteExternalIdentifier(
            table.name,
            this.external.dialect
        )
        const quotedWatermark = quoteExternalIdentifier(
            table.watermarkColumn,
            this.external.dialect
        )

        const whereClause =
            lastValue !== null ? `WHERE ${quotedWatermark} > ?` : ''
        const params = lastValue !== null ? [lastValue] : []
        const selectSql =
            `SELECT * FROM ${quotedSource} ${whereClause} ORDER BY ${quotedWatermark} ASC LIMIT ${this.batchSize}`.trim()

        const rows = await this.fetchExternal(dataSource, selectSql, params)

        if (!rows || rows.length === 0) {
            return { table: table.name, rowsReplicated: 0, lastValue }
        }

        let newLastValue: string | null = lastValue
        for (const row of rows) {
            await this.upsertRow(dataSource, destTable, table.primaryKey, row)

            const watermark = row[table.watermarkColumn]
            if (watermark !== undefined && watermark !== null) {
                newLastValue = pickHigherWatermark(newLastValue, watermark)
            }
        }

        if (newLastValue !== null && newLastValue !== lastValue) {
            await this.setLastValue(dataSource, table.name, newLastValue)
        }

        return {
            table: table.name,
            rowsReplicated: rows.length,
            lastValue: newLastValue,
        }
    }

    private async fetchExternal(
        dataSource: DataSource,
        sql: string,
        params: unknown[]
    ): Promise<Array<Record<string, any>>> {
        const externalDataSource: DataSource = {
            ...dataSource,
            source: 'external',
            external: this.external,
        }

        const result = await executeSDKQuery({
            sql,
            params,
            dataSource: externalDataSource,
            config: this.config ?? { role: 'admin' },
        })

        return Array.isArray(result) ? result : []
    }

    private async upsertRow(
        dataSource: DataSource,
        table: string,
        primaryKey: string,
        row: Record<string, any>
    ) {
        const columns = Object.keys(row)
        if (columns.length === 0) return

        const placeholders = columns.map(() => '?').join(', ')
        const columnsList = columns.map((c) => `"${c}"`).join(', ')
        const updateAssignments = columns
            .filter((c) => c !== primaryKey)
            .map((c) => `"${c}" = excluded."${c}"`)
            .join(', ')

        let sql = `INSERT INTO "${table}" (${columnsList}) VALUES (${placeholders})`
        if (updateAssignments) {
            sql += ` ON CONFLICT("${primaryKey}") DO UPDATE SET ${updateAssignments}`
        }

        await dataSource.rpc.executeQuery({
            sql,
            params: columns.map((c) => row[c]),
        })
    }
}

/**
 * Compare two watermark values and return whichever is "higher". When both
 * sides parse as numbers we compare numerically so id=99 < id=100 (a plain
 * lexicographic compare would say "99" > "100"). Otherwise we fall back to
 * string compare, which already handles ISO timestamps correctly.
 */
function pickHigherWatermark(
    current: string | null,
    candidate: unknown
): string {
    const candidateStr = String(candidate)
    if (current === null) return candidateStr

    const currentNum = Number(current)
    const candidateNum = Number(candidateStr)
    const bothNumeric =
        current.trim() !== '' &&
        candidateStr.trim() !== '' &&
        Number.isFinite(currentNum) &&
        Number.isFinite(candidateNum)

    if (bothNumeric) {
        return candidateNum > currentNum ? candidateStr : current
    }
    return candidateStr > current ? candidateStr : current
}
