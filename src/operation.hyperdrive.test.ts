import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { executeQuery } from './operation'
import type { DataSource } from './types'
import type { StarbaseDBConfiguration } from './handler'

const client = vi.hoisted(() => ({ unsafe: vi.fn(), end: vi.fn() }))

vi.mock('postgres', () => ({ default: vi.fn(() => client) }))
vi.mock('./allowlist', () => ({ isQueryAllowed: vi.fn() }))
vi.mock('./rls', () => ({ applyRLS: vi.fn(async ({ sql }) => sql) }))
vi.mock('./cache', () => ({
    beforeQueryCache: vi.fn(async () => null),
    afterQueryCache: vi.fn(),
}))

beforeEach(() => {
    vi.clearAllMocks()
    client.unsafe.mockReset().mockResolvedValue([{ id: 1 }])
    client.end.mockReset().mockResolvedValue(undefined)
    vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => vi.restoreAllMocks())

describe('Hyperdrive connection lifecycle', () => {
    for (const background of [false, true]) {
        const mode = background ? 'with waitUntil' : 'without waitUntil'

        function run(waitUntil: ReturnType<typeof vi.fn>) {
            return executeQuery({
                sql: 'SELECT id FROM records WHERE id = $1',
                params: [1],
                isRaw: false,
                dataSource: {
                    source: 'hyperdrive',
                    external: { connectionString: 'postgres://localhost/test' },
                    ...(background ? { executionContext: { waitUntil } } : {}),
                } as unknown as DataSource,
                config: {
                    role: 'admin',
                    features: {},
                } as StarbaseDBConfiguration,
            })
        }

        it(`closes the client after success ${mode}`, async () => {
            const waitUntil = vi.fn()
            await expect(run(waitUntil)).resolves.toEqual([{ id: 1 }])
            expect(client.unsafe).toHaveBeenCalledWith(
                'SELECT id FROM records WHERE id = $1',
                [1]
            )
            expect(client.end).toHaveBeenCalledTimes(1)
            if (background) {
                expect(waitUntil).toHaveBeenCalledWith(
                    client.end.mock.results[0].value
                )
            } else {
                expect(waitUntil).not.toHaveBeenCalled()
            }
        })

        it(`closes the client and preserves query failure ${mode}`, async () => {
            const failure = new Error('query failed')
            client.unsafe.mockRejectedValueOnce(failure)
            const waitUntil = vi.fn()
            await expect(run(waitUntil)).rejects.toBe(failure)
            expect(client.end).toHaveBeenCalledTimes(1)
            if (background) {
                expect(waitUntil).toHaveBeenCalledWith(
                    client.end.mock.results[0].value
                )
            } else {
                expect(waitUntil).not.toHaveBeenCalled()
            }
        })
    }
})
