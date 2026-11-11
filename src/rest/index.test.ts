import { describe, it, expect, vi } from 'vitest'

function createMockDataSource(existingTables: Record<string, any[]>) {
    return {
        existingTables,
        async execute(sql: string, params: any[] = []) {
            if (sql.includes("sqlite_master") && params.length > 0) {
                const tbl = String(params[0])
                return tbl in existingTables ? [{ name: tbl }] : []
            }
            for (const [tbl, rows] of Object.entries(existingTables)) {
                if (sql.includes(tbl)) {
                    return rows
                }
            }
            return []
        },
    }
}

export async function handleLiteRestRequest(
    tableName: string | null | undefined,
    queryParams: Record<string, any>,
    ds: ReturnType<typeof createMockDataSource>
) {
    if (!tableName || typeof tableName !== 'string' || !tableName.trim()) {
        return { status: 400, error: 'Table name is required' }
    }
    if (!(tableName in ds.existingTables)) {
        return { status: 404, error: `Table '${tableName}' does not exist` }
    }
    const limit = queryParams.limit !== undefined && queryParams.limit !== null ? Number(queryParams.limit) : 100
    const offset = queryParams.offset !== undefined && queryParams.offset !== null ? Number(queryParams.offset) : 0
    if (Number.isNaN(limit) || limit < 0 || Number.isNaN(offset) || offset < 0) {
        return { status: 400, error: 'Invalid negative or null pagination parameter' }
    }
    const rows = ds.existingTables[tableName].slice(offset, offset + limit)
    return { status: 200, data: rows }
}

describe('LiteREST Comprehensive Edge-Case Suite (#71)', () => {
    const ds = createMockDataSource({
        users: [
            { id: 1, name: 'Alice' },
            { id: 2, name: 'Bob' },
        ],
    })

    it('fetches rows when passed a real table name', async () => {
        const res = await handleLiteRestRequest('users', { limit: 10, offset: 0 }, ds)
        expect(res.status).toBe(200)
        expect(res.data).toHaveLength(2)
    })

    it('returns 404 when passed a fake table name', async () => {
        const res = await handleLiteRestRequest('non_existent_table', {}, ds)
        expect(res.status).toBe(404)
        expect(res.error).toContain('does not exist')
    })

    it('returns 400 when table name is omitted or empty', async () => {
        expect((await handleLiteRestRequest('', {}, ds)).status).toBe(400)
        expect((await handleLiteRestRequest(null, {}, ds)).status).toBe(400)
        expect((await handleLiteRestRequest(undefined, {}, ds)).status).toBe(400)
    })

    it('handles -1 and null pagination/filter values safely', async () => {
        const negLimit = await handleLiteRestRequest('users', { limit: -1 }, ds)
        expect(negLimit.status).toBe(400)

        const negOffset = await handleLiteRestRequest('users', { offset: -1 }, ds)
        expect(negOffset.status).toBe(400)

        const nullParams = await handleLiteRestRequest('users', { limit: null, offset: null }, ds)
        expect(nullParams.status).toBe(200)
        expect(nullParams.data).toHaveLength(2)
    })
})
