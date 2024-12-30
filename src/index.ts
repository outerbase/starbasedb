import { createResponse } from './utils'
import { StarbaseDB, StarbaseDBConfiguration } from './handler'
import { DataSource, RegionLocationHint } from './types'
import { createRemoteJWKSet, jwtVerify } from 'jose'
import { handleStudioRequest } from './studio'
import { corsPreflight } from './cors'

export { StarbaseDBDurableObject } from './do'

const DURABLE_OBJECT_ID = 'sql-durable-object'

export interface Env {
    ADMIN_AUTHORIZATION_TOKEN: string
    CLIENT_AUTHORIZATION_TOKEN: string
    // DATABASE_DURABLE_OBJECT: DurableObjectNamespace<
    //     import('./do').StarbaseDBDurableObject
    // >
    DATABASE_DURABLE_OBJECT_WNAM: DurableObjectNamespace<
        import('./do').StarbaseDBDurableObject
    >
    DATABASE_DURABLE_OBJECT_ENAM: DurableObjectNamespace<
        import('./do').StarbaseDBDurableObject
    >
    DATABASE_DURABLE_OBJECT_WEUR: DurableObjectNamespace<
        import('./do').StarbaseDBDurableObject
    >
    DATABASE_DURABLE_OBJECT_EEUR: DurableObjectNamespace<
        import('./do').StarbaseDBDurableObject
    >
    DATABASE_DURABLE_OBJECT_APAC: DurableObjectNamespace<
        import('./do').StarbaseDBDurableObject
    >

    REGION: string
    PRIMARY_REGION: string

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

    // ## DO NOT REMOVE: TEMPLATE INTERFACE ##
}

const REGIONS = {
    wnam: 'DATABASE_DURABLE_OBJECT_WNAM',
    enam: 'DATABASE_DURABLE_OBJECT_ENAM',
    weur: 'DATABASE_DURABLE_OBJECT_WEUR',
    eeur: 'DATABASE_DURABLE_OBJECT_EEUR',
    apac: 'DATABASE_DURABLE_OBJECT_APAC',
} as const

async function broadcastToSecondaries(env: Env, event: any) {
    const allRegions = Object.keys(REGIONS) as (keyof typeof REGIONS)[]
    const secondaryRegions = allRegions.filter(
        (region) => region !== env.PRIMARY_REGION
    )

    // Broadcast to all secondary regions
    const broadcasts = secondaryRegions.map(async (region) => {
        const binding = REGIONS[region] as keyof Env
        const namespace = env[binding] as DurableObjectNamespace<
            import('./do').StarbaseDBDurableObject
        >
        const id = namespace.idFromName(`${DURABLE_OBJECT_ID}-${region}`)
        const stub = namespace.get(id)

        try {
            console.log(
                `Replicating to region: ${region} to binding ${binding}`
            )
            // Assuming you'll implement a replication endpoint in your DO
            await stub.fetch('http://internal/replicate', {
                method: 'POST',
                body: JSON.stringify(event),
                headers: {
                    'Content-Type': 'application/json',
                },
            })
        } catch (error) {
            console.error(`Failed to replicate to ${region}:`, error)
        }
    })

    await Promise.all(broadcasts)
}

// Add this helper function to map Cloudflare colo codes to our regions
function getRegionFromColo(colo: string): keyof typeof REGIONS | undefined {
    // Cloudflare colo codes: https://developers.cloudflare.com/api/operations/worker-metrics/get-http-requests
    const coloToRegion: { [key: string]: keyof typeof REGIONS } = {
        // North America West (examples)
        LAX: 'wnam',
        SFO: 'wnam',
        SEA: 'wnam',
        DEN: 'wnam',
        // North America East
        EWR: 'enam',
        IAD: 'enam',
        ATL: 'enam',
        // Europe West
        LHR: 'weur',
        CDG: 'weur',
        AMS: 'weur',
        // Europe East
        VIE: 'eeur',
        WAW: 'eeur',
        // Asia Pacific
        NRT: 'apac',
        SIN: 'apac',
        HKG: 'apac',
        // Add more mappings as needed
    }

    return coloToRegion[colo]
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

            // Handle Studio requests before auth checks in the worker.
            // StarbaseDB can handle this for us, but we need to handle it
            // here before auth checks.
            if (
                env.STUDIO_USER &&
                env.STUDIO_PASS &&
                request.method === 'GET' &&
                url.pathname === '/studio'
            ) {
                return handleStudioRequest(request, {
                    username: env.STUDIO_USER,
                    password: env.STUDIO_PASS,
                    apiKey: env.ADMIN_AUTHORIZATION_TOKEN,
                })
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
                    role = 'admin'
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

            /**
             * Retrieve the Durable Object identifier from the environment bindings and instantiate a
             * Durable Object stub to interact with the Durable Object.
             */

            let actualRegion = 'enam' // WIP: Currently defaulting to `enam`, should be more dynamic.
            if ('cf' in request) {
                const cf = (request as Request & { cf: { colo: string } }).cf
                console.log('colo: ', cf.colo)

                const detectedRegion = getRegionFromColo(cf.colo)
                if (detectedRegion) {
                    actualRegion = detectedRegion
                }
            }

            console.log('Current Region: ', actualRegion)

            // const id: DurableObjectId =
            //     env.DATABASE_DURABLE_OBJECT.idFromName(DURABLE_OBJECT_ID)
            // const stub =
            //     actualRegion !== RegionLocationHint.AUTO
            //         ? env.DATABASE_DURABLE_OBJECT.get(id, {
            //               locationHint: actualRegion as DurableObjectLocationHint,
            //           })
            //         : env.DATABASE_DURABLE_OBJECT.get(id)

            // Any MUTATING request should go to the PRIMARY_REGION
            // Any READ requests can go to the closest nearby region (for faster subsequent caching)
            // let isDataMutationRequest = false

            // // Check if this is a query endpoint by examining the URL path
            // const isQueryEndpoint = url.pathname.toLowerCase() === '/query';

            // // For query endpoints, check if it's a mutation based on the SQL
            // if (isQueryEndpoint) {
            //     const body = await request.json() as any;
            //     const sql = body.sql?.toLowerCase() || '';
            //     const transaction = body.transaction as { sql: string, params: any[] }[];

            //     // Check both the main SQL and any transaction SQLs for mutations
            //     // This is a super oversimplified way of doing this, for testing purposes only
            //     const hasMutation = (sqlStr: string) =>
            //         sqlStr.includes('insert') ||
            //         sqlStr.includes('update') ||
            //         sqlStr.includes('delete') ||
            //         sqlStr.includes('truncate') ||
            //         sqlStr.includes('alter') ||
            //         sqlStr.includes('drop');

            //     const transactionHasMutation = transaction?.some(t => hasMutation(t.sql.toLowerCase()));
            //     isDataMutationRequest = hasMutation(sql) || transactionHasMutation;
            // }

            // if (isDataMutationRequest) {
            //     // Send request to PRIMARY_REGION durable object
            //     // Which will then fan out to the other regions via SSE
            // } else {
            //     // Send request to closest nearby durable object
            // }

            // Determine if this is the primary region
            const isPrimaryRegion = env.PRIMARY_REGION === actualRegion
            actualRegion = 'weur'

            // Get the appropriate DO namespace based on the region
            const regionBinding = REGIONS[
                actualRegion as keyof typeof REGIONS
            ] as keyof Env
            const namespace = env[regionBinding] as DurableObjectNamespace<
                import('./do').StarbaseDBDurableObject
            >
            // Include region in the DO name to ensure unique IDs
            const id = namespace.idFromName(
                `${DURABLE_OBJECT_ID}-${actualRegion}`
            )
            const stub = namespace.get(id)

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
                        : 'internal'
                    : 'internal',
                cache: request.headers.get('X-Starbase-Cache') === 'true',
                context: {
                    ...context,
                },
            }

            if (
                env.EXTERNAL_DB_TYPE === 'postgresql' ||
                env.EXTERNAL_DB_TYPE === 'mysql'
            ) {
                dataSource.external = {
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

            const config: StarbaseDBConfiguration = {
                outerbaseApiKey: env.OUTERBASE_API_KEY,
                role,
                features: {
                    allowlist: env.ENABLE_ALLOWLIST,
                    rls: env.ENABLE_RLS,
                    studio: false, // This is handled above in the worker flow.
                },
            }

            const starbase = new StarbaseDB({
                dataSource,
                config,
            })

            // If this is a write operation and we're the primary, broadcast to secondaries
            // if (isPrimaryRegion && request.method !== 'GET') {
            const clonedRequest = request.clone()
            const body = await clonedRequest.json()

            // Broadcast the event to all secondary regions
            ctx.waitUntil(
                broadcastToSecondaries(env, {
                    method: request.method,
                    path: new URL(request.url).pathname,
                    body,
                    timestamp: Date.now(),
                })
            )
            // }

            // If this is not the primary region and it's a write operation, reject
            // if (!isPrimaryRegion && request.method !== 'GET') {
            //     return createResponse(
            //         undefined,
            //         'Write operations are only allowed on the primary region',
            //         403
            //     )
            // }

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
