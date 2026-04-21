/**
 * Chunk formatting helpers for async export.
 * These produce the same output format as the existing synchronous export routes.
 */

export function formatChunkAsSQL(
    tableName: string,
    rows: Record<string, unknown>[]
): string {
    let result = ''
    for (const row of rows) {
        const values = Object.values(row).map((value) =>
            typeof value === 'string'
                ? `'${value.replace(/'/g, "''")}'`
                : value === null
                  ? 'NULL'
                  : value
        )
        result += `INSERT INTO ${tableName} VALUES (${values.join(', ')});\n`
    }
    return result
}

export function formatChunkAsJSON(
    rows: Record<string, unknown>[],
    isFirst: boolean,
    isLast: boolean
): string {
    let result = ''
    if (isFirst) {
        result += '[\n'
    }
    for (let i = 0; i < rows.length; i++) {
        if (!isFirst || i > 0) {
            result += ',\n'
        }
        result += JSON.stringify(rows[i], null, 4)
    }
    if (isLast) {
        result += '\n]'
    }
    return result
}

export function formatChunkAsCSV(
    rows: Record<string, unknown>[],
    includeHeaders: boolean
): string {
    if (rows.length === 0) return ''

    let result = ''
    if (includeHeaders) {
        result += Object.keys(rows[0]).join(',') + '\n'
    }

    for (const row of rows) {
        result +=
            Object.values(row)
                .map((value) => {
                    if (value === null || value === undefined) return ''
                    const str = String(value)
                    if (
                        str.includes(',') ||
                        str.includes('"') ||
                        str.includes('\n')
                    ) {
                        return `"${str.replace(/"/g, '""')}"`
                    }
                    return str
                })
                .join(',') + '\n'
    }

    return result
}
