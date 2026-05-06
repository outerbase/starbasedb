import { describe, it, expect, vi, beforeEach } from 'vitest'
import { breathe, chunksToStream, iterateTableRows } from './streaming'
import { executeOperation } from './index'
import type { DataSource } from '../types'
import type { StarbaseDBConfiguration } from '../handler'

vi.mock('./index', () => ({
    executeOperation: vi.fn(),
}))

let mockDataSource: DataSource
let mockConfig: StarbaseDBConfiguration

beforeEach(() => {
    vi.clearAllMocks()
    mockDataSource = {
        source: 'external',
        external: { dialect: 'sqlite' },
        rpc: { executeQuery: vi.fn() },
    } as any
    mockConfig = {
        outerbaseApiKey: 'k',
        role: 'admin',
        features: { allowlist: true, rls: true, rest: true },
    }
})

describe('iterateTableRows', () => {
    it('issues a single query when the first page is short', async () => {
        vi.mocked(executeOperation).mockResolvedValueOnce([
            { id: 1 },
            { id: 2 },
        ])

        const out: any[] = []
        for await (const row of iterateTableRows(
            'users',
            mockDataSource,
            mockConfig,
            10
        )) {
            out.push(row)
        }

        expect(out).toEqual([{ id: 1 }, { id: 2 }])
        expect(executeOperation).toHaveBeenCalledTimes(1)
        // Page-size and offset are passed as bound params, not interpolated.
        expect(vi.mocked(executeOperation).mock.calls[0][0][0].params).toEqual([
            10, 0,
        ])
    })

    it('pages until a short page terminates the loop', async () => {
        // Two full pages of size 2, then a partial page of 1 row.
        vi.mocked(executeOperation)
            .mockResolvedValueOnce([{ id: 1 }, { id: 2 }])
            .mockResolvedValueOnce([{ id: 3 }, { id: 4 }])
            .mockResolvedValueOnce([{ id: 5 }])

        const out: any[] = []
        for await (const row of iterateTableRows(
            'users',
            mockDataSource,
            mockConfig,
            2
        )) {
            out.push(row)
        }

        expect(out.map((r) => r.id)).toEqual([1, 2, 3, 4, 5])
        expect(executeOperation).toHaveBeenCalledTimes(3)
        // Offsets advance by the configured page size.
        const offsets = vi
            .mocked(executeOperation)
            .mock.calls.map(([qs]) => qs[0].params?.[1])
        expect(offsets).toEqual([0, 2, 4])
    })

    it('terminates immediately on an empty page', async () => {
        vi.mocked(executeOperation).mockResolvedValueOnce([])

        const out: any[] = []
        for await (const row of iterateTableRows(
            'empty',
            mockDataSource,
            mockConfig
        )) {
            out.push(row)
        }

        expect(out).toEqual([])
        expect(executeOperation).toHaveBeenCalledTimes(1)
    })
})

describe('breathe', () => {
    it('prefers scheduler.wait when available', async () => {
        const wait = vi.fn().mockResolvedValue(undefined)
        ;(globalThis as any).scheduler = { wait }
        try {
            await breathe()
            expect(wait).toHaveBeenCalledWith(0)
        } finally {
            delete (globalThis as any).scheduler
        }
    })

    it('falls back to setTimeout(0) without scheduler', async () => {
        // Just confirm it resolves; the absence of scheduler is the path.
        await expect(breathe()).resolves.toBeUndefined()
    })
})

describe('chunksToStream', () => {
    it('encodes generator output as a UTF-8 byte stream', async () => {
        async function* gen() {
            yield 'hello, '
            yield 'world'
        }

        const stream = chunksToStream(gen())
        const text = await new Response(stream).text()
        expect(text).toBe('hello, world')
    })

    it('propagates generator errors to the stream consumer', async () => {
        async function* gen() {
            yield 'partial'
            throw new Error('boom')
        }

        const stream = chunksToStream(gen())
        await expect(new Response(stream).text()).rejects.toThrow('boom')
    })
})
