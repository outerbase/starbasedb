import { beforeEach, describe, expect, it, vi } from 'vitest'
import worker from './index'
import { StarbaseDB } from './handler'
import { jwtVerify } from 'jose'
const state = {
    handle: vi.fn(),
    pre: vi.fn(),
    route: vi.fn(),
    options: null as any,
}
vi.mock('./do', () => ({ StarbaseDBDurableObject: class {} }))
vi.mock('./handler', () => ({
    StarbaseDB: vi.fn().mockImplementation((options) => {
        state.options = options
        return { handle: state.handle, handlePreAuth: state.pre }
    }),
}))
vi.mock('jose', () => ({ createRemoteJWKSet: vi.fn(), jwtVerify: vi.fn() }))
vi.mock('../plugins/websocket', () => ({ WebSocketPlugin: class {} }))
vi.mock('../plugins/studio', () => ({ StudioPlugin: class {} }))
vi.mock('../plugins/sql-macros', () => ({ SqlMacrosPlugin: class {} }))
vi.mock('../plugins/query-log', () => ({ QueryLogPlugin: class {} }))
vi.mock('../plugins/stats', () => ({ StatsPlugin: class {} }))
vi.mock('../plugins/cdc', () => ({
    ChangeDataCapturePlugin: class {
        onEvent = vi.fn()
    },
}))
vi.mock('../plugins/cron', () => ({
    CronPlugin: class {
        onEvent = vi.fn()
    },
}))
vi.mock('../plugins/interface', () => ({
    InterfacePlugin: class {
        matchesRoute = state.route
    },
}))
let env: any
let stub: any
const ctx = { waitUntil: vi.fn() } as any
const request = (headers = {}, suffix = '') =>
    new Request('https://worker.test/query' + suffix, { headers })
beforeEach(() => {
    vi.clearAllMocks()
    state.pre.mockResolvedValue(undefined)
    state.route.mockReturnValue(false)
    state.handle.mockResolvedValue(new Response('handled'))
    stub = { init: vi.fn().mockResolvedValue({ executeQuery: vi.fn() }) }
    env = {
        ADMIN_AUTHORIZATION_TOKEN: 'admin',
        CLIENT_AUTHORIZATION_TOKEN: 'client',
        DATABASE_DURABLE_OBJECT: {
            idFromName: vi.fn().mockReturnValue('id'),
            get: vi.fn().mockReturnValue(stub),
        },
    }
})
describe('Worker authentication and routing', () => {
    it('answers preflight before opening a durable object', async () => {
        expect(
            (
                await worker.fetch(
                    new Request('https://worker.test', { method: 'OPTIONS' }),
                    env,
                    ctx
                )
            ).status
        ).toBe(204)
        expect(stub.init).not.toHaveBeenCalled()
    })
    it('rejects missing credentials before handling a query', async () => {
        expect((await worker.fetch(request(), env, ctx)).status).toBe(401)
        expect(state.handle).not.toHaveBeenCalled()
    })
    it.each([
        ['admin', 'admin'],
        ['client', 'client'],
    ])('assigns the %s role', async (token, role) => {
        expect(
            (
                await worker.fetch(
                    request({ Authorization: 'Bearer ' + token }),
                    env,
                    ctx
                )
            ).status
        ).toBe(200)
        expect(state.options.config.role).toBe(role)
    })
    it('rejects an unknown token without a JWT provider', async () => {
        expect(
            (
                await worker.fetch(
                    request({ Authorization: 'Bearer wrong' }),
                    env,
                    ctx
                )
            ).status
        ).toBe(400)
        expect(state.handle).not.toHaveBeenCalled()
    })
    it.each([undefined, 'RS256'])(
        'validates JWTs with optional configured algorithm %s',
        async (algorithm) => {
            env.AUTH_JWKS_ENDPOINT = 'https://issuer.test/jwks'
            env.AUTH_ALGORITHM = algorithm
            vi.mocked(jwtVerify).mockResolvedValue({
                payload: { sub: 'user' },
            } as any)
            expect(
                (
                    await worker.fetch(
                        request({ Authorization: 'Bearer jwt' }),
                        env,
                        ctx
                    )
                ).status
            ).toBe(200)
            expect(jwtVerify).toHaveBeenCalledWith('jwt', undefined, {
                algorithms: algorithm ? [algorithm] : undefined,
            })
        }
    )
    it('rejects a JWT without a subject', async () => {
        env.AUTH_JWKS_ENDPOINT = 'https://issuer.test/jwks'
        vi.mocked(jwtVerify).mockResolvedValue({ payload: {} } as any)
        expect(
            (
                await worker.fetch(
                    request({ Authorization: 'Bearer jwt' }),
                    env,
                    ctx
                )
            ).status
        ).toBe(400)
        expect(state.handle).not.toHaveBeenCalled()
    })
    it('handles verifier rejection without an error message', async () => {
        env.AUTH_JWKS_ENDPOINT = 'https://issuer.test/jwks'
        vi.mocked(jwtVerify).mockRejectedValue(null)
        const response = await worker.fetch(
            request({ Authorization: 'Bearer jwt' }),
            env,
            ctx
        )
        expect(response.status).toBe(400)
        expect(await response.text()).toContain('Unable to process request')
    })
    it('accepts websocket query credentials', async () => {
        expect(
            (
                await worker.fetch(
                    request({ Upgrade: 'websocket' }, '?token=client'),
                    env,
                    ctx
                )
            ).status
        ).toBe(200)
        expect(state.handle).toHaveBeenCalledOnce()
    })
    it('rejects a websocket without a token', async () => {
        expect(
            (await worker.fetch(request({ Upgrade: 'websocket' }), env, ctx))
                .status
        ).toBe(401)
    })
    it('honors a plugin pre-auth response', async () => {
        state.pre.mockResolvedValue(new Response('plugin', { status: 202 }))
        expect((await worker.fetch(request(), env, ctx)).status).toBe(202)
        expect(state.handle).not.toHaveBeenCalled()
    })
    it('delegates a matching public interface route', async () => {
        state.route.mockReturnValue(true)
        expect((await worker.fetch(request(), env, ctx)).status).toBe(200)
        expect(state.handle).toHaveBeenCalledOnce()
    })
    it.each([new Error('offline'), 'offline'])(
        'reports initialization failures %s',
        async (error) => {
            stub.init.mockRejectedValue(error)
            expect((await worker.fetch(request(), env, ctx)).status).toBe(400)
            expect(state.handle).not.toHaveBeenCalled()
        }
    )
})
describe('Worker data source configuration', () => {
    it.each([
        ['external', 'external'],
        [' HYPERDRIVE ', 'hyperdrive'],
        ['unknown', 'internal'],
    ])('normalizes source %s', async (source, expected) => {
        await worker.fetch(
            request({
                'X-Starbase-Source': source,
                Authorization: 'Bearer client',
            }),
            env,
            ctx
        )
        expect(state.options.dataSource.source).toBe(expected)
    })
    it('uses query source, cache flag and region hint', async () => {
        env.REGION = 'weur'
        await worker.fetch(
            request(
                { 'X-Starbase-Cache': 'true', Authorization: 'Bearer client' },
                '?source=external'
            ),
            env,
            ctx
        )
        expect(state.options.dataSource.source).toBe('external')
        expect(state.options.dataSource.cache).toBe(true)
        expect(env.DATABASE_DURABLE_OBJECT.get).toHaveBeenCalledWith('id', {
            locationHint: 'weur',
        })
    })
    it.each(['postgresql', 'mysql'])(
        'passes %s connection configuration',
        async (dialect) => {
            Object.assign(env, {
                EXTERNAL_DB_TYPE: dialect,
                EXTERNAL_DB_HOST: 'db.test',
                EXTERNAL_DB_DEFAULT_SCHEMA: 'tenant',
            })
            await worker.fetch(
                request({ Authorization: 'Bearer client' }),
                env,
                ctx
            )
            expect(state.options.dataSource.external).toMatchObject({
                dialect,
                host: 'db.test',
                defaultSchema: 'tenant',
            })
        }
    )
    it.each([
        [{ EXTERNAL_DB_CLOUDFLARE_API_KEY: 'key' }, 'cloudflare-d1'],
        [{ EXTERNAL_DB_STARBASEDB_URI: 'https://db.test' }, 'starbase'],
        [{ EXTERNAL_DB_TURSO_URI: 'libsql://db.test' }, 'turso'],
    ])('selects the SQLite provider %j', async (extra, provider) => {
        Object.assign(env, { EXTERNAL_DB_TYPE: 'sqlite' }, extra)
        await worker.fetch(
            request({ Authorization: 'Bearer client' }),
            env,
            ctx
        )
        expect(state.options.dataSource.external.provider).toBe(provider)
    })
    it('uses the Hyperdrive binding when present', async () => {
        env.HYPERDRIVE = { connectionString: 'postgres://db.test' }
        await worker.fetch(
            request({ Authorization: 'Bearer client' }),
            env,
            ctx
        )
        expect(state.options.dataSource.external.connectionString).toBe(
            'postgres://db.test'
        )
    })
})
