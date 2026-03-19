/**
 * External database read adapter — PostgreSQL / Hyperdrive first; pluggable interface.
 * Writes always go to SQLite via Durable Object RPC (not through this adapter).
 */
import postgres from 'postgres'
import type { DataSource, ExternalDatabaseSource } from '../../src/types'
import type { StarbaseDBConfiguration } from '../../src/handler'
import { executeSDKQuery } from '../../src/operation'

export interface ExternalReadAdapter {
    /** Run a read-only statement on the external database; returns row objects */
    query<T extends Record<string, unknown> = Record<string, unknown>>(
        sql: string,
        params?: unknown[]
    ): Promise<T[]>
}

function isHyperdrivePostgres(
    ext: ExternalDatabaseSource | undefined
): ext is Extract<ExternalDatabaseSource, { connectionString: string }> {
    return (
        !!ext &&
        ext.dialect === 'postgresql' &&
        'connectionString' in ext &&
        !!ext.connectionString
    )
}

function isHostPostgres(
    ext: ExternalDatabaseSource | undefined
): ext is Extract<
    ExternalDatabaseSource,
    { dialect: 'postgresql'; host: string }
> {
    return !!ext && ext.dialect === 'postgresql' && 'host' in ext && !!ext.host
}

/**
 * Create a reader for the external DB configured on `dataSource.external`.
 * Reuses StarbaseDB's existing drivers (pg via SDK) or `postgres` for Hyperdrive.
 */
export function createExternalReadAdapter(
    dataSource: DataSource,
    config: StarbaseDBConfiguration,
    ctx?: ExecutionContext
): ExternalReadAdapter | null {
    const ext = dataSource.external
    if (!ext) return null

    if (isHyperdrivePostgres(ext)) {
        return {
            async query(sql, params = []) {
                const sqlConn = postgres(ext.connectionString, {
                    max: 1,
                    fetch_types: false,
                })
                try {
                    return (await sqlConn.unsafe(
                        sql,
                        params as never[]
                    )) as Record<string, unknown>[]
                } finally {
                    if (ctx) ctx.waitUntil(sqlConn.end())
                    else await sqlConn.end()
                }
            },
        }
    }

    if (isHostPostgres(ext) || ext.dialect === 'mysql') {
        const readSource: DataSource = {
            ...dataSource,
            source: 'external',
            external: ext,
        }
        return {
            async query(sql, params = []) {
                const rows = await executeSDKQuery({
                    sql,
                    params,
                    dataSource: readSource,
                    config,
                })
                return (Array.isArray(rows) ? rows : []) as Record<
                    string,
                    unknown
                >[]
            },
        }
    }

    return null
}

/** Quote a PostgreSQL identifier (schema/table/column) — validates simple names */
export function quotePgIdent(ident: string): string {
    const parts = ident
        .split('.')
        .map((p) => p.trim())
        .filter(Boolean)
    const safe = /^[a-zA-Z_][a-zA-Z0-9_]*$/
    for (const p of parts) {
        if (!safe.test(p)) {
            throw new Error(
                `[data-sync] Invalid PostgreSQL identifier segment: ${p}`
            )
        }
    }
    return parts.map((p) => `"${p.replace(/"/g, '""')}"`).join('.')
}
