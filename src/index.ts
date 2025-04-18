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

export default {
    /**
     * This is the standard fetch handler for a Cloudflare Worker
     *
     * @param request - The request submitted to the Worker from the client
     * @param env - The interface to reference bindings declared in wrangler.toml
     * @param ctx - The execution context of the Worker
     * @returns The response to be sent back to the client
     */
    async fetch(request, env, ctx): Promise<Response> {
        try {
            const url = new URL(request.url)
            const isWebSocket = request.headers.get('Upgrade') === 'websocket'

            let role: StarbaseDBConfiguration['role'] = 'client'
            let context = {}

            // Authorize the request with CORS rules before proceeding.
            if (request.method === 'OPTIONS') {
                const preflightResponse = corsPreflight()

                if (preflightResponse) {
                    return preflightResponse
                }
            }

            /**
             * Retrieve the Durable Object identifier from the environment bindings and instantiate a
             * Durable Object stub to interact with the Durable Object.
             */
            const region = env.REGION ?? RegionLocationHint.AUTO
            const id: DurableObjectId =
                env.DATABASE_DURABLE_OBJECT.idFromName(DURABLE_OBJECT_ID)
            const stub =
                region !== RegionLocationHint.AUTO
                    ? env.DATABASE_DURABLE_OBJECT.get(id, {
                          locationHint: region as DurableObjectLocationHint,
                      })
                    : env.DATABASE_DURABLE_OBJECT.get(id)

            // Create a new RPC Session on the Durable Object.
            const rpc = await stub.init()

            // Get the source type from headers/query params.
            const source =
                request.headers.get('X-Starbase-Source') ||
                url.searchParams.get('source') // TODO: Should this come from here, or per-websocket message?

            const dataSource: DataSource = {
                rpc,
                source: source
                    ? source.toLowerCase().trim() === 'external'
                        ? 'external'
                        : source.toLowerCase().trim() === 'hyperdrive'
                          ? 'hyperdrive'
                          : 'internal'
                    : 'internal',
                cache: request.headers.get('X-Starbase-Cache') === 'true',
                context: {
                    ...context,
                },
                executionContext: ctx,
            }

            if (env.EXTERNAL_DB_TYPE === 'postgresql') {
                dataSource.external = {
                    dialect: 'postgresql',
                    host: env.EXTERNAL_DB_HOST!,
                    port: env.EXTERNAL_DB_PORT!,
                    user: env.EXTERNAL_DB_USER!,
                    password: env.EXTERNAL_DB_PASS!,
                    database: env.EXTERNAL_DB_DATABASE!,
                    defaultSchema: env.EXTERNAL_DB_DEFAULT_SCHEMA,
                }
            } else if (env.EXTERNAL_DB_TYPE === 'mysql') {
                dataSource.external = {
                    dialect: 'mysql',
                    host: env.EXTERNAL_DB_HOST!,
                    port: env.EXTERNAL_DB_PORT!,
                    user: env.EXTERNAL_DB_USER!,
                    password: env.EXTERNAL_DB_PASS!,
                    database: env.EXTERNAL_DB_DATABASE!,
                    defaultSchema: env.EXTERNAL_DB_DEFAULT_SCHEMA,
                }
            }

            if (env.EXTERNAL_DB_TYPE === 'sqlite') {
                if (env.EXTERNAL_DB_CLOUDFLARE_API_KEY) {
                    dataSource.external = {
                        dialect: 'sqlite',
                        provider: 'cloudflare-d1',
                        apiKey: env.EXTERNAL_DB_CLOUDFLARE_API_KEY,
                        accountId: env.EXTERNAL_DB_CLOUDFLARE_ACCOUNT_ID!,
                        databaseId: env.EXTERNAL_DB_CLOUDFLARE_DATABASE_ID!,
                    }
                }

                if (env.EXTERNAL_DB_STARBASEDB_URI) {
                    dataSource.external = {
                        dialect: 'sqlite',
                        provider: 'starbase',
                        apiKey: env.EXTERNAL_DB_STARBASEDB_URI,
                        token: env.EXTERNAL_DB_STARBASEDB_TOKEN!,
                        defaultSchema: env.EXTERNAL_DB_DEFAULT_SCHEMA,
                    }
                }

                if (env.EXTERNAL_DB_TURSO_URI) {
                    dataSource.external = {
                        dialect: 'sqlite',
                        provider: 'turso',
                        uri: env.EXTERNAL_DB_TURSO_URI,
                        token: env.EXTERNAL_DB_TURSO_TOKEN!,
                        defaultSchema: env.EXTERNAL_DB_DEFAULT_SCHEMA,
                    }
                }
            }

            if (env.HYPERDRIVE?.connectionString) {
                dataSource.external = {
                    dialect: 'postgresql',
                    connectionString: env.HYPERDRIVE.connectionString,
                }
            }

            const config: StarbaseDBConfiguration = {
                outerbaseApiKey: env.OUTERBASE_API_KEY,
                role,
                features: {
                    allowlist: env.ENABLE_ALLOWLIST,
                    rls: env.ENABLE_RLS,
                },
            }

            const webSocketPlugin = new WebSocketPlugin()
            const cronPlugin = new CronPlugin()
            const cdcPlugin = new ChangeDataCapturePlugin({
                stub,
                broadcastAllEvents: false,
                events: [],
            })

            cdcPlugin.onEvent(async ({ action, schema, table, data }) => {
                // Include change data capture code here
            }, ctx)

            cronPlugin.onEvent(async ({ name, cron_tab, payload }) => {
                // Include cron event code here
            }, ctx)

            const interfacePlugin = new InterfacePlugin()

            const plugins = [
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
            ] satisfies StarbasePlugin[]

            const starbase = new StarbaseDB({
                dataSource,
                config,
                plugins,
            })

            const preAuthRequest = await starbase.handlePreAuth(request, ctx)

            if (preAuthRequest) {
                return preAuthRequest
            }

            // When our InterfacePlugin has a supported path within it then we
            // are making the assumption here that it is rendering a UI page for
            // our users to visually load and we should return early before the
            // next authentication checks happen. If a page is meant to have any
            // sort of authentication, it can provide Basic Auth itself or expose
            // itself in another plugin.
            if (interfacePlugin.matchesRoute(url.pathname)) {
                return await starbase.handle(request, ctx)
            }

            async function authenticate(token: string) {
                const isAdminAuthorization =
                    token === env.ADMIN_AUTHORIZATION_TOKEN
                const isClientAuthorization =
                    token === env.CLIENT_AUTHORIZATION_TOKEN

                // If not admin or client auth, check if JWT auth is available
                if (!isAdminAuthorization && !isClientAuthorization) {
                    if (env.AUTH_JWKS_ENDPOINT) {
                        const { payload } = await jwtVerify(
                            token,
                            createRemoteJWKSet(new URL(env.AUTH_JWKS_ENDPOINT)),
                            {
                                algorithms: env.AUTH_ALGORITHM
                                    ? [env.AUTH_ALGORITHM]
                                    : undefined,
                            }
                        )

                        if (!payload.sub) {
                            throw new Error(
                                'Invalid JWT payload, subject not found.'
                            )
                        }

                        context = payload
                    } else {
                        // If no JWT secret or JWKS endpoint is provided, then the request has no authorization.
                        throw new Error('Unauthorized request')
                    }
                } else if (isAdminAuthorization) {
                    config.role = 'admin'
                }
            }

            // JWT Payload from Header or WebSocket query param.
            let authenticationToken: string | null = null

            /**
             * Prior to proceeding to the Durable Object, we can perform any necessary validation or
             * authorization checks here to ensure the request signature is valid and authorized to
             * interact with the Durable Object.
             */
            if (!isWebSocket) {
                authenticationToken =
                    request.headers
                        .get('Authorization')
                        ?.replace('Bearer ', '') ?? null
            } else if (isWebSocket) {
                authenticationToken = url.searchParams.get('token')
            }

            // There must be some form of authentication token provided to proceed.
            if (!authenticationToken) {
                return createResponse(undefined, 'Unauthorized request', 401)
            }

            try {
                await authenticate(authenticationToken)
            } catch (error: any) {
                return createResponse(
                    undefined,
                    error?.message ?? 'Unable to process request.',
                    400
                )
            }

            // Return the final response to our user
            return await starbase.handle(request, ctx)
        } catch (error) {
            // Return error response to client
            return createResponse(
                undefined,
                error instanceof Error
                    ? error.message
                    : 'An unexpected error occurred',
                400
            )
        }
    },
} satisfies ExportedHandler<Env>
