export type ExternalDialect = 'postgresql' | 'mysql' | 'sqlite'

export type SyncTableConfig = {
    sourceTable: string
    targetTable: string
    cursorColumn: string
    sourceSchema?: string
    batchSize: number
}

const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

export const DEFAULT_BATCH_SIZE = 250
export const MIN_BATCH_SIZE = 10
export const MAX_BATCH_SIZE = 2000

export function validateIdentifier(identifier: string, kind: string): string {
    const trimmed = identifier.trim()

    if (!IDENTIFIER_PATTERN.test(trimmed)) {
        throw new Error(`Invalid ${kind}: ${identifier}`)
    }

    return trimmed
}

export function clampBatchSize(value: unknown): number {
    const parsed = Number(value)

    if (!Number.isFinite(parsed)) {
        return DEFAULT_BATCH_SIZE
    }

    return Math.max(MIN_BATCH_SIZE, Math.min(MAX_BATCH_SIZE, Math.floor(parsed)))
}

export function quoteIdentifier(identifier: string, dialect: ExternalDialect): string {
    const validated = validateIdentifier(identifier, 'identifier')

    if (dialect === 'mysql') {
        return `\`${validated}\``
    }

    return `"${validated}"`
}

export function inferSQLiteType(value: unknown): string {
    if (typeof value === 'number') {
        return Number.isInteger(value) ? 'INTEGER' : 'REAL'
    }

    if (typeof value === 'bigint') {
        return 'INTEGER'
    }

    if (typeof value === 'boolean') {
        return 'INTEGER'
    }

    if (value instanceof Uint8Array) {
        return 'BLOB'
    }

    return 'TEXT'
}

export function toSqliteValue(value: unknown): unknown {
    if (value === undefined) {
        return null
    }

    if (typeof value === 'boolean') {
        return value ? 1 : 0
    }

    if (typeof value === 'bigint') {
        return value.toString()
    }

    if (value && typeof value === 'object' && !(value instanceof Uint8Array)) {
        return JSON.stringify(value)
    }

    return value
}

export function parseCursorValue(value: string | null): unknown {
    if (value === null) {
        return null
    }

    try {
        return JSON.parse(value)
    } catch {
        return value
    }
}

export function serializeCursorValue(value: unknown): string {
    return JSON.stringify(value)
}
