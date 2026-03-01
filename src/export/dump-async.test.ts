import { describe, it, expect, vi, beforeEach } from 'vitest'
import { initiateDump, processDumpChunk, getDumpStatus } from './dump-async'

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSql(
    tables: Record<string, { ddl: string; rows: Record<string, unknown>[] }>
): SqlStorage {
    const mock = {
        exec: vi.fn((sql: string, ...params: unknown[]) => {
            // sqlite_master DDL query for a specific table
            const tableNameMatch = sql.match(/name=\?/) && (params[0] as string)
            if (tableNameMatch && tables[tableNameMatch]) {
                return { toArray: () => [{ sql: tables[tableNameMatch].ddl }] }
            }

            // sqlite_master list all tables
            if (sql.includes("type='table'") && sql.includes('ORDER BY name')) {
                return {
                    toArray: () =>
                        Object.keys(tables).map((name) => ({ name })),
                }
            }

            // SELECT * FROM table LIMIT ? OFFSET ?
            const dataMatch = sql.match(/FROM "([^"]+)" LIMIT \? OFFSET \?/)
            if (dataMatch) {
                const tableName = dataMatch[1]
                const limit = params[0] as number
                const offset = params[1] as number
                const rows = tables[tableName]?.rows ?? []
                return { toArray: () => rows.slice(offset, offset + limit) }
            }

            return { toArray: () => [] }
        }),
        databaseSize: 1024,
    } as unknown as SqlStorage
    return mock
}

function makeR2Bucket() {
    const uploadedParts: Record<
        string,
        { partNumber: number; data: string }[]
    > = {}
    const completedObjects: Record<string, string> = {}

    return {
        createMultipartUpload: vi.fn(async (key: string) => ({
            uploadId: `upload-${key}`,
            uploadPart: vi.fn(async (partNumber: number, data: string) => {
                if (!uploadedParts[key]) uploadedParts[key] = []
                uploadedParts[key].push({ partNumber, data })
                return { partNumber, etag: `etag-${partNumber}` }
            }),
            complete: vi.fn(async () => {
                completedObjects[key] = (uploadedParts[key] ?? [])
                    .sort((a, b) => a.partNumber - b.partNumber)
                    .map((p) => p.data)
                    .join('')
            }),
            abort: vi.fn(),
        })),
        resumeMultipartUpload: vi.fn((key: string, _uploadId: string) => ({
            uploadPart: vi.fn(async (partNumber: number, data: string) => {
                if (!uploadedParts[key]) uploadedParts[key] = []
                uploadedParts[key].push({ partNumber, data })
                return { partNumber, etag: `etag-${partNumber}` }
            }),
            complete: vi.fn(async () => {
                completedObjects[key] = (uploadedParts[key] ?? [])
                    .sort((a, b) => a.partNumber - b.partNumber)
                    .map((p) => p.data)
                    .join('')
            }),
            abort: vi.fn(),
        })),
        get: vi.fn(async (key: string) => {
            if (!(key in completedObjects)) return null
            const body = completedObjects[key]
            return {
                body: new ReadableStream({
                    start(controller) {
                        controller.enqueue(new TextEncoder().encode(body))
                        controller.close()
                    },
                }),
            }
        }),
        _completedObjects: completedObjects,
    } as unknown as R2Bucket & { _completedObjects: Record<string, string> }
}

function makeStorage() {
    const store = new Map<string, unknown>()
    return {
        get: vi.fn(async (key: string) => store.get(key) ?? null),
        put: vi.fn(async (key: string, value: unknown) => {
            store.set(key, value)
        }),
        delete: vi.fn(async (key: string) => {
            store.delete(key)
        }),
        _store: store,
    } as unknown as DurableObjectStorage & { _store: Map<string, unknown> }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('initiateDump', () => {
    it('creates a dump state and returns a dumpId', async () => {
        const sql = makeSql({
            users: {
                ddl: 'CREATE TABLE users (id INTEGER, name TEXT)',
                rows: [],
            },
        })
        const r2 = makeR2Bucket()
        const storage = makeStorage()

        const result = await initiateDump(sql, r2 as any, storage as any)

        expect(result.dumpId).toBeTruthy()
        expect(r2.createMultipartUpload).toHaveBeenCalledOnce()
        const state = storage._store.get(`dump:${result.dumpId}`) as any
        expect(state.status).toBe('running')
        expect(state.tables).toEqual(['users'])
    })

    it('rejects a second dump when one is already running', async () => {
        const sql = makeSql({})
        const r2 = makeR2Bucket()
        const storage = makeStorage()

        const { dumpId } = await initiateDump(sql, r2 as any, storage as any)
        // The storage now has activeDumpId pointing to a running dump
        await expect(
            initiateDump(sql, r2 as any, storage as any)
        ).rejects.toThrow(/already in progress/)
    })
})

describe('processDumpChunk + getDumpStatus', () => {
    it('processes a small database in a single chunk and marks it complete', async () => {
        const sql = makeSql({
            users: {
                ddl: 'CREATE TABLE users (id INTEGER, name TEXT)',
                rows: [
                    { id: 1, name: 'Alice' },
                    { id: 2, name: 'Bob' },
                ],
            },
        })
        const r2 = makeR2Bucket()
        const storage = makeStorage()

        const { dumpId } = await initiateDump(sql, r2 as any, storage as any)
        const isDone = await processDumpChunk(
            sql,
            r2 as any,
            storage as any,
            dumpId
        )

        expect(isDone).toBe(true)

        const status = await getDumpStatus(storage as any, dumpId)
        expect(status?.status).toBe('complete')
        expect(status?.downloadPath).toBe(`/export/dump/${dumpId}/download`)
    })

    it('produces valid SQL INSERT statements in the dump', async () => {
        const sql = makeSql({
            products: {
                ddl: 'CREATE TABLE products (id INTEGER, title TEXT, price REAL)',
                rows: [
                    { id: 1, title: "O'Brien's Ale", price: 4.99 },
                    { id: 2, title: null, price: 0 },
                ],
            },
        })
        const r2 = makeR2Bucket() as any
        const storage = makeStorage()

        const { dumpId } = await initiateDump(sql, r2, storage as any)
        await processDumpChunk(sql, r2, storage as any, dumpId)

        const state = storage._store.get(`dump:${dumpId}`) as any
        // Retrieve the upload key
        const key = state.uploadKey
        // The completed object should contain INSERT statements
        const content = r2._completedObjects[key]
        expect(content).toContain('CREATE TABLE products')
        expect(content).toContain('INSERT INTO "products"')
        expect(content).toContain("'O''Brien''s Ale'") // escaped single quote
        expect(content).toContain('NULL') // null value
    })

    it('returns null status for an unknown dumpId', async () => {
        const storage = makeStorage()
        const status = await getDumpStatus(storage as any, 'nonexistent-id')
        expect(status).toBeNull()
    })

    it('handles an empty database gracefully', async () => {
        const sql = makeSql({})
        const r2 = makeR2Bucket()
        const storage = makeStorage()

        const { dumpId } = await initiateDump(sql, r2 as any, storage as any)
        const isDone = await processDumpChunk(
            sql,
            r2 as any,
            storage as any,
            dumpId
        )

        expect(isDone).toBe(true)
        const status = await getDumpStatus(storage as any, dumpId)
        expect(status?.status).toBe('complete')
    })

    it('calls callback URL on completion', async () => {
        const fetchMock = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValueOnce(new Response('ok', { status: 200 }))

        const sql = makeSql({
            t: { ddl: 'CREATE TABLE t (id INTEGER)', rows: [{ id: 1 }] },
        })
        const r2 = makeR2Bucket()
        const storage = makeStorage()

        const { dumpId } = await initiateDump(
            sql,
            r2 as any,
            storage as any,
            'https://my-app.example.com/dump-done'
        )
        await processDumpChunk(sql, r2 as any, storage as any, dumpId)

        expect(fetchMock).toHaveBeenCalledWith(
            'https://my-app.example.com/dump-done',
            expect.objectContaining({ method: 'POST' })
        )

        fetchMock.mockRestore()
    })
})
