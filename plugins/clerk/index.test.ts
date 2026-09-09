import { describe, it, expect, vi } from 'vitest'
import { ClerkPlugin } from './index'

function makeDataSource(rows: any[] = []) {
    return {
        rpc: {
            executeQuery: vi.fn(async () => rows as any),
        },
    } as any
}

const BASE_OPTS = {
    clerkSigningSecret: 'whsec_test',
    dataSource: makeDataSource(),
}

describe('ClerkPlugin - construction', () => {
    it('registers under the clerk plugin name and opens webhooks without auth', () => {
        const plugin = new ClerkPlugin({ ...BASE_OPTS })
        expect(plugin.name).toBe('starbasedb:clerk')
        expect(plugin.pathPrefix).toBe('/clerk')
        expect(plugin.opts.requiresAuth).toBe(false)
    })

    it('throws a clear error when the signing secret is missing', () => {
        expect(
            () => new ClerkPlugin({ dataSource: makeDataSource() } as any)
        ).toThrow('A signing secret is required for this plugin.')
    })

    it('defaults session verification on and origins to empty', () => {
        const plugin = new ClerkPlugin({ ...BASE_OPTS })
        expect(plugin.verifySessions).toBe(true)
        expect(plugin.permittedOrigins).toEqual([])
    })

    it('honours explicit verification and origin options', () => {
        const plugin = new ClerkPlugin({
            ...BASE_OPTS,
            verifySessions: false,
            permittedOrigins: ['https://app.example.com'],
        })
        expect(plugin.verifySessions).toBe(false)
        expect(plugin.permittedOrigins).toEqual(['https://app.example.com'])
    })
})

describe('ClerkPlugin - sessionExistsInDb', () => {
    it('returns true when a matching session row exists', async () => {
        const plugin = new ClerkPlugin({
            ...BASE_OPTS,
            dataSource: makeDataSource([{ id: 'sess_1' }]),
        })
        await expect(
            plugin.sessionExistsInDb({ sub: 'user_1', sid: 'sess_1' })
        ).resolves.toBe(true)
    })

    it('returns false when no session row exists', async () => {
        const plugin = new ClerkPlugin({
            ...BASE_OPTS,
            dataSource: makeDataSource([]),
        })
        await expect(
            plugin.sessionExistsInDb({ sub: 'user_1', sid: 'missing' })
        ).resolves.toBe(false)
    })

    it('queries with the session id first, then the user id', async () => {
        const ds = makeDataSource([])
        const plugin = new ClerkPlugin({ ...BASE_OPTS, dataSource: ds })
        await plugin.sessionExistsInDb({ sub: 'user_9', sid: 'sess_9' })
        const lastCall = ds.rpc.executeQuery.mock.calls.at(-1)[0]
        expect(lastCall.params).toEqual(['sess_9', 'user_9'])
    })

    it('returns false instead of throwing when the database errors', async () => {
        const ds = {
            rpc: {
                executeQuery: vi.fn(async () => {
                    throw new Error('db down')
                }),
            },
        } as any
        const plugin = new ClerkPlugin({ ...BASE_OPTS, dataSource: ds })
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        await expect(
            plugin.sessionExistsInDb({ sub: 'u', sid: 's' })
        ).resolves.toBe(false)
        errSpy.mockRestore()
    })
})

describe('ClerkPlugin - authenticate early exits', () => {
    it('returns false when verification is disabled', async () => {
        const plugin = new ClerkPlugin({ ...BASE_OPTS, verifySessions: false })
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        await expect(plugin.authenticate({})).resolves.toBe(false)
        errSpy.mockRestore()
    })

    it('returns false when no session key and no token are provided', async () => {
        const plugin = new ClerkPlugin({
            ...BASE_OPTS,
            clerkSessionPublicKey: 'unused-in-this-path',
        })
        await expect(plugin.authenticate({ cookie: 'other=1' })).resolves.toBe(
            false
        )
    })
})
