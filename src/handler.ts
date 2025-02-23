import { Context, Hono } from 'hono'
import { createMiddleware } from 'hono/factory'
import { validator } from 'hono/validator'

import { DataSource } from './types'
import { LiteREST } from './literest'
import { executeQuery, executeTransaction } from './operation'
import {
    createResponse,
    QueryRequest,
    QueryTransactionRequest,
    getFeatureFromConfig,
} from './utils'
import { dumpDatabaseRoute } from './export/dump'
import { exportTableToJsonRoute } from './export/json'
import { exportTableToCsvRoute } from './export/csv'
import { importDumpRoute } from './import/dump'
import { importTableFromJsonRoute } from './import/json'
import { importTableFromCsvRoute } from './import/csv'
import { corsPreflight } from './cors'
import { handleApiRequest } from './api'
import { StarbasePlugin, StarbasePluginRegistry } from './plugin'

export interface StarbaseDBConfiguration {
    outerbaseApiKey?: string
    role: 'admin' | 'client'
    features?: {
        allowlist?: boolean
        rls?: boolean
        rest?: boolean
        websocket?: boolean
        export?: boolean
        import?: boolean
        studio?: boolean
        cron?: boolean
        cdc?: boolean
        interface?: boolean
    }
}

type HonoContext = {
    Variables: {
        config: StarbaseDBConfiguration
        dataSource: DataSource
        operations: {
            executeQuery: typeof executeQuery
            executeTransaction: typeof executeTransaction
        }
    }
}

export class StarbaseDB {
    private dataSource: DataSource
    private config: StarbaseDBConfiguration
    private liteREST: LiteREST
    private plugins: StarbasePlugin[]
    private initialized: boolean = false
    private app: StarbaseApp

    constructor(options: {
        dataSource: DataSource
        config: StarbaseDBConfiguration
        plugins?: StarbasePlugin[]
    }) {
        this.dataSource = options.dataSource
        this.config = options.config
        this.liteREST = new LiteREST(this.dataSource, this.config)
        this.plugins = options.plugins || []
        this.app = new Hono<HonoContext>()

        if (
            this.dataSource.source === 'external' &&
            !this.dataSource.external
        ) {
            throw new Error('No external data sources available.')
        }
    }

    private async initialize() {
        if (this.initialized) return

        // Set up middleware first
        this.app.use('*', async (c, next) => {
            c.set('config', this.config)
            c.set('dataSource', this.dataSource)
            c.set('operations', {
                executeQuery,
                executeTransaction,
            })
            return next()
        })

        // Initialize plugins
        const registry = new StarbasePluginRegistry({
            app: this.app,
            plugins: this.plugins,
        })
        await registry.init()
        this.dataSource.registry = registry

        this.app.post('/query/raw', async (c) =>
            this.queryRoute(c.req.raw, true)
        )
        this.app.post('/query', async (c) => this.queryRoute(c.req.raw, false))
        this.app.get('/status/trace', async (c) => {
            const response = await fetch('https://cloudflare.com/cdn-cgi/trace')
            return new Response(response.body, {
                headers: response.headers,
            })
        })

        if (this.getFeature('rest')) {
            this.app.all('/rest/*', async (c) => {
                return this.liteREST.handleRequest(c.req.raw)
            })
        }

        if (this.getFeature('export')) {
            this.app.get('/export/dump', this.isInternalSource, async () => {
                return dumpDatabaseRoute(this.dataSource, this.config)
            })

            this.app.get(
                '/export/json/:tableName',
                this.isInternalSource,
                this.hasTableName,
                async (c) => {
                    const tableName = c.req.valid('param').tableName
                    return exportTableToJsonRoute(
                        tableName,
                        this.dataSource,
                        this.config
                    )
                }
            )

            this.app.get(
                '/export/csv/:tableName',
                this.isInternalSource,
                this.hasTableName,
                async (c) => {
                    const tableName = c.req.valid('param').tableName
                    return exportTableToCsvRoute(
                        tableName,
                        this.dataSource,
                        this.config
                    )
                }
            )
        }

        if (this.getFeature('import')) {
            this.app.post('/import/dump', this.isInternalSource, async (c) => {
                return importDumpRoute(c.req.raw, this.dataSource, this.config)
            })

            this.app.post(
                '/import/json/:tableName',
                this.isInternalSource,
                this.hasTableName,
                async (c) => {
                    const tableName = c.req.valid('param').tableName
                    return importTableFromJsonRoute(
                        tableName,
                        c.req.raw,
                        this.dataSource,
                        this.config
                    )
                }
            )

            this.app.post(
                '/import/csv/:tableName',
                this.isInternalSource,
                this.hasTableName,
                async (c) => {
                    const tableName = c.req.valid('param').tableName
                    return importTableFromCsvRoute(
                        tableName,
                        c.req.raw,
                        this.dataSource,
                        this.config
                    )
                }
            )
        }

        this.app.all('/api/*', async (c) => handleApiRequest(c.req.raw))

        // Set up error handlers
        this.app.notFound(() => {
            return createResponse(undefined, 'Not found', 404)
        })

        this.app.onError((error) => {
            return createResponse(
                undefined,
                error?.message || 'An unexpected error occurred.',
                500
            )
        })

        this.initialized = true
    }

    public async handlePreAuth(
        request: Request,
        ctx: ExecutionContext
    ): Promise<Response | undefined> {
        // Initialize everything once
        await this.initialize()

        const authlessPlugin = this.plugins.find((plugin: StarbasePlugin) => {
            if (!plugin.opts.requiresAuth && request.url && plugin.pathPrefix) {
                // Extract the path from the full URL
                const urlPath = new URL(request.url).pathname

                // Convert plugin path pattern to regex
                const pathPattern = plugin.pathPrefix
                    .replace(/:[^/]+/g, '[^/]+') // Replace :param with regex pattern
                    .replace(/\*/g, '.*') // Replace * with wildcard pattern

                const regex = new RegExp(`^${pathPattern}`)
                return regex.test(urlPath)
            }

            return false
        })

        if (authlessPlugin) {
            return this.app.fetch(request)
        }

        return undefined
    }

    public async handle(
        request: Request,
        ctx: ExecutionContext
    ): Promise<Response> {
        // Initialize everything once
        await this.initialize()

        // Non-blocking operation to remove expired cache entries from our DO
        ctx.waitUntil(this.expireCache())

        // CORS preflight handler
        if (request.method === 'OPTIONS') {
            return corsPreflight()
        }

        return this.app.fetch(request)
    }

    /**
     * Middleware to check if the request is coming from an internal source.
     */
    private get isInternalSource() {
        return createMiddleware(async (_, next) => {
            if (this.dataSource.source !== 'internal') {
                return createResponse(
                    undefined,
                    'Function is only available for internal data source.',
                    400
                )
            }

            return next()
        })
    }

    /**
     * Validator middleware to check if the request path has a valid :tableName parameter.
     */
    private get hasTableName() {
        return validator('param', (params) => {
            const tableName = params['tableName'].trim()

            if (!tableName) {
                return createResponse(undefined, 'Table name is required', 400)
            }

            return { tableName }
        })
    }

    /**
     * Helper function to get a feature flag from the configuration.
     * @param key The feature key to get.
     * @param defaultValue The default value to return if the feature is not defined.
     * @returns
     */
    private getFeature(
        key: keyof NonNullable<StarbaseDBConfiguration['features']>,
        defaultValue?: boolean
    ): boolean {
        return getFeatureFromConfig(this.config.features)(key, defaultValue)
    }

    async queryRoute(request: Request, isRaw: boolean): Promise<Response> {
        try {
            const contentType = request.headers.get('Content-Type') || ''
            if (!contentType.includes('application/json')) {
                return createResponse(
                    undefined,
                    'Content-Type must be application/json.',
                    400
                )
            }

            const { sql, params, transaction } =
                (await request.json()) as QueryRequest & QueryTransactionRequest

            if (Array.isArray(transaction) && transaction.length) {
                const queries = transaction.map((queryObj: any) => {
                    const { sql, params } = queryObj

                    if (typeof sql !== 'string' || !sql.trim()) {
                        throw new Error(
                            'Invalid or empty "sql" field in transaction.'
                        )
                    } else if (
                        params !== undefined &&
                        !Array.isArray(params) &&
                        typeof params !== 'object'
                    ) {
                        throw new Error(
                            'Invalid "params" field in transaction. Must be an array or object.'
                        )
                    }

                    return { sql, params }
                })

                const response = await executeTransaction({
                    queries,
                    isRaw,
                    dataSource: this.dataSource,
                    config: this.config,
                })

                return createResponse(response, undefined, 200)
            } else if (typeof sql !== 'string' || !sql.trim()) {
                return createResponse(
                    undefined,
                    'Invalid or empty "sql" field.',
                    400
                )
            } else if (
                params !== undefined &&
                !Array.isArray(params) &&
                typeof params !== 'object'
            ) {
                return createResponse(
                    undefined,
                    'Invalid "params" field. Must be an array or object.',
                    400
                )
            }

            const response = await executeQuery({
                sql,
                params,
                isRaw,
                dataSource: this.dataSource,
                config: this.config,
            })
            return createResponse(response, undefined, 200)
        } catch (error: any) {
            console.error('Query Route Error:', error)
            return createResponse(
                undefined,
                error?.message || 'An unexpected error occurred.',
                500
            )
        }
    }

    /**
     *
     */
    private async expireCache() {
        try {
            const cleanupSQL = `DELETE FROM tmp_cache WHERE timestamp + (ttl * 1000) < ?`
            this.dataSource.rpc.executeQuery({
                sql: cleanupSQL,
                params: [Date.now()],
            })
        } catch (err) {
            console.error('Error cleaning up expired cache entries:', err)
        }
    }
}

export type StarbaseApp = Hono<HonoContext>
export type StarbaseContext = Context<HonoContext>
