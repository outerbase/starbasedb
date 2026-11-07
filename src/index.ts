import { createResponse } from './utils'
import { StarbaseDB, StarbaseDBConfiguration } from './handler'
import { DataSource, RegionLocationHint } from './types'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { corsPreflight } from './cors'
import { StarbasePlugin } from './plugin'
import { WebSocketPlugin } from '../plugins/websocket'
import { StudioPlugin } from '../plugins/studio'
import { SqlMacrosPlugin } from '../plugins/sql-macros'
import { ChangeDataCapturePlugin } from '../plugins/cdc'
import { QueryLogPlugin } from '../plugins/query-log'
import { StatsPlugin } from '../plugins/stats'
import { CronPlugin } from '../plugins/cron'
import { InterfacePlugin } from '../plugins/interface'

export { StarbaseDBDurableObject } from './do'

const DURABLE_OBJECT_ID = 'sql-durable-object'

const SOURCE_TYPE_MAP: Record<string, DataSource['source']> = {
    external: 'external',
    hyperdrive: 'hyperdrive',
}

export interface Env {
    ADMIN_AUTHORIZATION_TOKEN: string
    CLIENT_AUTHORIZATION_TOKEN: string
    DATABASE_DURABLE_OBJECT: DurableObjectNamespace<
        import('./do').StarbaseDBDurableObject
    >
    REGION: string

    // Studio credentials
    STUDIO_USER?: string
    STUDIO_PASS?: string

    ENABLE_ALLOWLIST?: boolean
    ALLOWLIST_BYPASS_REST?: boolean
    ENABLE_RLS?: boolean

    // External database source details
    OUTERBASE_API_KEY?: string
    EXTERNAL_DB_TYPE?: string
    EXTERNAL_DB_HOST?: string
    EXTERNAL_DB_PORT?: number
    EXTERNAL_DB_USER?: string
    EXTERNAL_DB_PASS?: string
    EXTERNAL_DB_DATABASE?: string
    EXTERNAL_DB_DEFAULT_SCHEMA?: string

    EXTERNAL_DB_MONGODB_URI?: string
    EXTERNAL_DB_TURSO_URI?: string
    EXTERNAL_DB_TURSO_TOKEN?: string
    EXTERNAL_DB_STARBASEDB_URI?: string
    EXTERNAL_DB_STARBASEDB_TOKEN?: string
    EXTERNAL_DB_CLOUDFLARE_API_KEY?: string
    EXTERNAL_DB_CLOUDFLARE_ACCOUNT_ID?: string
    EXTERNAL_DB_CLOUDFLARE_DATABASE_ID?: string

    AUTH_ALGORITHM?: string
    AUTH_JWKS_ENDPOINT?: string

    HYPERDRIVE: Hyperdrive

    // ## DO NOT REMOVE: TEMPLATE INTERFACE ##
}

function getDurableObjectStub(env: Env) {
    const region = env.REGION ?? RegionLocationHint.AUTO
    const id: DurableObjectId =
        env.DATABASE_DURABLE_OBJECT.idFromName(DURABLE_OBJECT_ID)

    if (region !== RegionLocationHint.AUTO) {
        return env.DATABASE_DURABLE_OBJECT.get(id, {
            locationHint: region as DurableObjectLocationHint,
        })
    }

    return env.DATABASE_DURABLE_OBJECT.get(id)
}

function resolveSourceType(
    request: Request,
    url: URL
): DataSource['source'] {
    const rawSource =
        request.headers.get('X-Starbase-Source') ||
        url.searchParams.get('source')

    if (!rawSource) {
        return 'internal'
    }

    return SOURCE_TYPE_MAP[rawSource.toLowerCase().trim()] ?? 'internal'
}

function resolveSqliteExternalSource(
    env: Env
): DataSource['external'] | undefined {
    if (env.EXTERNAL_DB_CLOUDFLARE_API_KEY) {
        return {
            dialect: 'sqlite',
            provider: 'cloudflare-d1',
            apiKey: env.EXTERNAL_DB_CLOUDFLARE_API_KEY,
            accountId: env.EXTERNAL_DB_CLOUDFLARE_ACCOUNT_ID!,
            databaseId: env.EXTERNAL_DB_CLOUDFLARE_DATABASE_ID!,
        }
    }

    if (env.EXTERNAL_DB_STARBASEDB_URI) {
        return {
            dialect: 'sqlite',
            provider: 'starbase',
            apiKey: env.EXTERNAL_DB_STARBASEDB_URI,
            token: env.EXTERNAL_DB_STARBASEDB_TOKEN!,
            defaultSchema: env.EXTERNAL_DB_DEFAULT_SCHEMA,
        }
    }

    if (env.EXTERNAL_DB_TURSO_URI) {
        return {
            dialect: 'sqlite',
            provider: 'turso',
            uri: env.EXTERNAL_DB_TURSO_URI,
            token: env.EXTERNAL_DB_TURSO_TOKEN!,
            defaultSchema: env.EXTERNAL_DB_DEFAULT_SCHEMA,
        }
    }

    return undefined
}

function resolveExternalSource(env: Env): DataSource['external'] | undefined {
    if (env.HYPERDRIVE?.connectionString) {
        return {
            dialect: 'postgresql',
            connectionString: env.HYPERDRIVE.connectionString,
        }
    }

    if (
        env.EXTERNAL_DB_TYPE === 'postgresql' ||
        env.EXTERNAL_DB_TYPE === 'mysql'
    ) {
        return {
            dialect: env.EXTERNAL_DB_TYPE,
            host: env.EXTERNAL_DB_HOST!,
            port: env.EXTERNAL_DB_PORT!,
            user: env.EXTERNAL_DB_USER!,
            password: env.EXTERNAL_DB_PASS!,
            database: env.EXTERNAL_DB_DATABASE!,
            defaultSchema: env.EXTERNAL_DB_DEFAULT_SCHEMA,
        }
    }

    if (env.EXTERNAL_DB_TYPE === 'sqlite') {
        return resolveSqliteExternalSource(env)
    }

    return undefined
}

function buildPlugins(opts: {
    env: Env
    stub: DurableObjectStub<import('./do').StarbaseDBDurableObject>
    ctx: ExecutionContext
}): { plugins: StarbasePlugin[]; interfacePlugin: InterfacePlugin } {
    const { env, stub, ctx } = opts
    const webSocketPlugin = new WebSocketPlugin()
    const cronPlugin = new CronPlugin()
    const cdcPlugin = new ChangeDataCapturePlugin({
        stub,
        broadcastAllEvents: false,
        events: [],
    })

    cdcPlugin.onEvent(async () => {
        // Application-level change data capture hook.
    }, ctx)

    cronPlugin.onEvent(async () => {
        // Application-level scheduled task hook.
    }, ctx)

    const interfacePlugin = new InterfacePlugin()
    const plugins: StarbasePlugin[] = [
        webSocketPlugin,
        new StudioPlugin({
            username: env.STUDIO_USER,
            password: env.STUDIO_PASS,
            apiKey: env.ADMIN_AUTHORIZATION_TOKEN,
        }),
        new SqlMacrosPlugin({
            preventSelectStar: false,
        }),
        new QueryLogPlugin({ ctx }),
        cdcPlugin,
        cronPlugin,
        new StatsPlugin(),
        interfacePlugin,
    ]

    return { plugins, interfacePlugin }
}

function extractAuthToken(request: Request, url: URL): string | null {
    const isWebSocket = request.headers.get('Upgrade') === 'websocket'
    if (isWebSocket) {
        return url.searchParams.get('token')
    }
    return (
        request.headers.get('Authorization')?.replace('Bearer ', '') ?? null
    )
}

async function verifyJwtPayload(
    token: string,
    env: Env
): Promise<Record<string, unknown>> {
    if (!env.AUTH_JWKS_ENDPOINT) {
        throw new Error('Unauthorized request')
    }

    const { payload } = await jwtVerify(
        token,
        createRemoteJWKSet(new URL(env.AUTH_JWKS_ENDPOINT)),
        {
            algorithms: env.AUTH_ALGORITHM ? [env.AUTH_ALGORITHM] : undefined,
        }
    )

    if (!payload.sub) {
        throw new Error('Invalid JWT payload, subject not found.')
    }

    return payload as Record<string, unknown>
}

async function authenticateRequest(opts: {
    token: string
    env: Env
    config: StarbaseDBConfiguration
    dataSource: DataSource
}): Promise<void> {
    const { token, env, config, dataSource } = opts
    if (token === env.ADMIN_AUTHORIZATION_TOKEN) {
        config.role = 'admin'
        return
    }

    if (token === env.CLIENT_AUTHORIZATION_TOKEN) {
        return
    }

    dataSource.context = await verifyJwtPayload(token, env)
}

async function initializeStarbaseInstance(opts: {
    request: Request
    url: URL
    env: Env
    ctx: ExecutionContext
}) {
    const { request, url, env, ctx } = opts
    const stub = getDurableObjectStub(env)
    const rpc = await stub.init()

    const dataSource: DataSource = {
        rpc,
        source: resolveSourceType(request, url),
        cache: request.headers.get('X-Starbase-Cache') === 'true',
        context: {},
        executionContext: ctx,
        external: resolveExternalSource(env),
    }

    const config: StarbaseDBConfiguration = {
        outerbaseApiKey: env.OUTERBASE_API_KEY,
        role: 'client',
        features: {
            allowlist: env.ENABLE_ALLOWLIST,
            allowlistBypassRest: env.ALLOWLIST_BYPASS_REST ?? true,
            rls: env.ENABLE_RLS,
        },
    }

    const { plugins, interfacePlugin } = buildPlugins({ env, stub, ctx })
    const starbase = new StarbaseDB({ dataSource, config, plugins })

    return { starbase, interfacePlugin, config, dataSource }
}

async function dispatchWorkerRequest(opts: {
    request: Request
    env: Env
    ctx: ExecutionContext
}): Promise<Response> {
    const { request, env, ctx } = opts
    const url = new URL(request.url)
    const { starbase, interfacePlugin, config, dataSource } =
        await initializeStarbaseInstance({ request, url, env, ctx })

    const preAuthRequest = await starbase.handlePreAuth(request, ctx)
    if (preAuthRequest) {
        return preAuthRequest
    }

    if (interfacePlugin.matchesRoute(url.pathname)) {
        return starbase.handle(request, ctx)
    }

    const authenticationToken = extractAuthToken(request, url)
    if (!authenticationToken) {
        return createResponse(undefined, 'Unauthorized request', 401)
    }

    await authenticateRequest({
        token: authenticationToken,
        env,
        config,
        dataSource,
    })

    return starbase.handle(request, ctx)
}

export default {
    /**
     * Cloudflare Worker entry point routing HTTP and WebSocket traffic to StarbaseDB.
     */
    async fetch(request, env, ctx): Promise<Response> {
        if (request.method === 'OPTIONS') {
            const preflightResponse = corsPreflight()
            if (preflightResponse) {
                return preflightResponse
            }
        }

        try {
            return await dispatchWorkerRequest({ request, env, ctx })
        } catch (error) {
            return createResponse(
                undefined,
                error instanceof Error
                    ? error.message
                    : 'Unable to process request.',
                400
            )
        }
    },
} satisfies ExportedHandler<Env>
