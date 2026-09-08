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

        it.each([new Error('query failed'), undefined])(
            `preserves query rejection %s when cleanup also rejects ${mode}`,
            async (failure) => {
                const cleanupFailure = new Error('cleanup failed')
                client.unsafe.mockRejectedValueOnce(failure)
                client.end.mockRejectedValueOnce(cleanupFailure)
                // Model the runtime observing background rejection, without
                // leaving an unhandled promise rejection in the test process.
                const waitUntil = vi.fn((promise: Promise<unknown>) => {
                    void promise.catch(() => {})
                })

                await expect(run(waitUntil)).rejects.toBe(failure)
                expect(client.end).toHaveBeenCalledTimes(1)
                if (background) {
                    const cleanup = client.end.mock.results[0].value
                    expect(waitUntil).toHaveBeenCalledWith(cleanup)
                    await expect(cleanup).rejects.toBe(cleanupFailure)
                } else {
                    expect(waitUntil).not.toHaveBeenCalled()
                    expect(console.error).toHaveBeenCalledWith(
                        'Hyperdrive cleanup error:',
                        cleanupFailure
                    )
                }
            }
        )

        it(`reports cleanup failure after query success ${mode}`, async () => {
            const cleanupFailure = new Error('cleanup failed')
            client.end.mockRejectedValueOnce(cleanupFailure)
            const waitUntil = vi.fn((promise: Promise<unknown>) => {
                void promise.catch(() => {})
            })

            if (background) {
                await expect(run(waitUntil)).resolves.toEqual([{ id: 1 }])
                const cleanup = client.end.mock.results[0].value
                expect(waitUntil).toHaveBeenCalledWith(cleanup)
                await expect(cleanup).rejects.toBe(cleanupFailure)
            } else {
                await expect(run(waitUntil)).rejects.toBe(cleanupFailure)
                expect(waitUntil).not.toHaveBeenCalled()
            }
            expect(client.end).toHaveBeenCalledTimes(1)
        })
    }
})
