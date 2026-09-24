import { beforeEach, describe, expect, it, vi } from 'vitest'
import { StarbaseDB } from './handler'
import type { DataSource } from './types'

const makeContext = () =>
    ({
        waitUntil: vi.fn(),
    }) as unknown as ExecutionContext

const makeSource = (large: boolean) => {
    const startDumpJob = vi.fn(async () => new Response('job', { status: 202 }))
    const executeQuery = vi.fn(async ({ sql }: { sql: string }) => {
        if (sql.includes('PRAGMA page_count')) {
            return [{ page_count: large ? 4096 : 1 }]
        }
        if (sql.includes('PRAGMA page_size')) {
            return [{ page_size: 4096 }]
        }
        if (sql.includes('SELECT name FROM sqlite_master')) {
            return [{ name: 't' }]
        }
        if (sql.includes('SELECT sql FROM sqlite_master')) {
            return [{ sql: 'CREATE TABLE t (id INTEGER)' }]
        }
        return []
    })
    const dataSource = {
        source: 'internal',
        rpc: {
            executeQuery,
            startDumpJob,
            dumpJobStatus: vi.fn(async () => new Response('status')),
        },
    } as unknown as DataSource
    return { dataSource, startDumpJob, executeQuery }
}

describe('StarbaseDB dump routing', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('automatically routes a large internal dump to a resumable job', async () => {
        const { dataSource, startDumpJob } = makeSource(true)
        const app = new StarbaseDB({
            dataSource,
            config: {
                role: 'admin',
                features: { export: true, rls: false, allowlist: false },
            },
        })
        const response = await app.handle(
            new Request('https://example.test/export/dump'),
            makeContext()
        )

        expect(response.status).toBe(202)
        expect(await response.text()).toBe('job')
        expect(startDumpJob).toHaveBeenCalledOnce()
    })

    it('keeps small internal dumps synchronous and preserves explicit job requests', async () => {
        const { dataSource, startDumpJob } = makeSource(false)
        const app = new StarbaseDB({
            dataSource,
            config: {
                role: 'admin',
                features: { export: true, rls: false, allowlist: false },
            },
        })

        const small = await app.handle(
            new Request('https://example.test/export/dump'),
            makeContext()
        )
        expect(small.status).toBe(200)
        expect(await small.text()).toContain('CREATE TABLE t')
        expect(startDumpJob).not.toHaveBeenCalled()

        const explicit = await app.handle(
            new Request('https://example.test/export/dump?job=1'),
            makeContext()
        )
        expect(explicit.status).toBe(202)
        expect(startDumpJob).toHaveBeenCalledOnce()
    })
})
