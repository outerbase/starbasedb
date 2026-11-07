import { Context, Hono } from 'hono'
import { createMiddleware } from 'hono/factory'
import { validator } from 'hono/validator'

import { DataSource } from './types'
import { LiteREST } from './literest'
import { executeQuery, executeTransaction } from './operation'
import { createResponse, QueryRequest, QueryTransactionRequest } from './utils'
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
        allowlistBypassRest?: boolean
        rls?: boolean
        rest?: boolean
        websocket?: boolean
        export?: boolean
        import?: boolean
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

function isNonEmptySql(sql: unknown): sql is string {
    return typeof sql === 'string' && sql.trim().length > 0
}

function isValidQueryParams(params: unknown): boolean {
    if (params === undefined) {
        return true
    }
    return Array.isArray(params) || typeof params === 'object'
}

function parseTransactionQueries(
    transaction: unknown[]
): { sql: string; params?: any[] }[] {
    return transaction.map((queryObj: any) => {
        const { sql, params } = queryObj ?? {}
        if (!isNonEmptySql(sql)) {
            throw new Error('Invalid or empty "sql" field in transaction.')
        }
        if (!isValidQueryParams(params)) {
            throw new Error(
                'Invalid "params" field in transaction. Must be an array or object.'
            )
        }
        return { sql, params }
    })
}

function matchesAuthlessPluginRoute(
    plugin: StarbasePlugin,
    requestUrl: string
): boolean {
    if (plugin.opts.requiresAuth) {
        return false
    }
    if (!requestUrl || !plugin.pathPrefix) {
        return false
    }

    const urlPath = new URL(requestUrl).pathname
    const pathPattern = plugin.pathPrefix
        .replace(/:[^/]+/g, '[^/]+')
        .replace(/\*/g, '.*')

    const regex = new RegExp(`^${pathPattern}`)
    return regex.test(urlPath)
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

    private registerCoreRoutes() {
        this.app.post('/query/raw', async (c) =>
            this.queryRoute(c.req.raw, true)
        )
        this.app.post('/query', async (c) => this.queryRoute(c.req.raw, false))
        this.app.get('/status/trace', async () => {
            const response = await fetch('https://cloudflare.com/cdn-cgi/trace')
            return new Response(response.body, {
                headers: response.headers,
            })
        })

        this.app.get('/status/database', async () => {
            return createResponse(
                {
                    dialects: {
                        external: this.dataSource.external?.dialect,
                        hyperdrive: 'postgresql',
                    },
                },
                undefined,
                200
            )
        })

        if (this.getFeature('rest')) {
            this.app.all('/rest/*', async (c) => {
                return this.liteREST.handleRequest(c.req.raw)
            })
        }

        this.app.all('/api/*', async (c) => handleApiRequest(c.req.raw))
    }

    private bindTableExportRoute(
        path: string,
        handler: typeof exportTableToJsonRoute
    ) {
        this.app.get(
            path,
            this.isInternalSource,
            this.hasTableName,
            async (c) =>
                handler(
                    c.req.valid('param').tableName,
                    this.dataSource,
                    this.config
                )
        )
    }

    private bindTableImportRoute(
        path: string,
        handler: typeof importTableFromJsonRoute
    ) {
        this.app.post(
            path,
            this.isInternalSource,
            this.hasTableName,
            async (c) =>
                handler(
                    c.req.valid('param').tableName,
                    c.req.raw,
                    this.dataSource,
                    this.config
                )
        )
    }

    private registerDataTransferRoutes() {
        if (this.getFeature('export')) {
            this.app.get('/export/dump', this.isInternalSource, async () =>
                dumpDatabaseRoute(this.dataSource, this.config)
            )
            this.bindTableExportRoute(
                '/export/json/:tableName',
                exportTableToJsonRoute
            )
            this.bindTableExportRoute(
                '/export/csv/:tableName',
                exportTableToCsvRoute
            )
        }

        if (this.getFeature('import')) {
            this.app.post('/import/dump', this.isInternalSource, async (c) =>
                importDumpRoute(c.req.raw, this.dataSource, this.config)
            )
            this.bindTableImportRoute(
                '/import/json/:tableName',
                importTableFromJsonRoute
            )
            this.bindTableImportRoute(
                '/import/csv/:tableName',
                importTableFromCsvRoute
            )
        }
    }

    private registerErrorHandlers() {
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
    }

    private async initialize() {
        if (this.initialized) return

        this.app.use('*', async (c, next) => {
            c.set('config', this.config)
            c.set('dataSource', this.dataSource)
            c.set('operations', {
                executeQuery,
                executeTransaction,
            })
            return next()
        })

        const registry = new StarbasePluginRegistry({
            app: this.app,
            plugins: this.plugins,
        })
        await registry.init()
        this.dataSource.registry = registry

        this.registerCoreRoutes()
        this.registerDataTransferRoutes()
        this.registerErrorHandlers()

        this.initialized = true
    }

    public async handlePreAuth(
        request: Request,
        _ctx: ExecutionContext
    ): Promise<Response | undefined> {
        await this.initialize()

        const authlessPlugin = this.plugins.find((plugin: StarbasePlugin) =>
            matchesAuthlessPluginRoute(plugin, request.url)
        )

        if (authlessPlugin) {
            return this.app.fetch(request)
        }

        return undefined
    }

    public async handle(
        request: Request,
        ctx: ExecutionContext
    ): Promise<Response> {
        await this.initialize()

        ctx.waitUntil(this.expireCache())

        if (request.method === 'OPTIONS') {
            return corsPreflight()
        }

        return this.app.fetch(request)
    }

    /**
     * Middleware restricting route execution to the internal Durable Object SQLite source.
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
     * Validator middleware verifying a non-empty :tableName route parameter.
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
     * Resolves a feature flag state from the active runtime configuration.
     */
    private getFeature(
        key: keyof NonNullable<StarbaseDBConfiguration['features']>,
        defaultValue = true
    ): boolean {
        return this.config.features?.[key] ?? !!defaultValue
    }

    private async executeParsedQueryPayload(
        payload: QueryRequest & QueryTransactionRequest,
        isRaw: boolean
    ): Promise<Response> {
        const { sql, params, transaction } = payload

        if (Array.isArray(transaction) && transaction.length > 0) {
            const queries = parseTransactionQueries(transaction)
            const response = await executeTransaction({
                queries,
                isRaw,
                dataSource: this.dataSource,
                config: this.config,
            })
            return createResponse(response, undefined, 200)
        }

        if (!isNonEmptySql(sql)) {
            return createResponse(
                undefined,
                'Invalid or empty "sql" field.',
                400
            )
        }

        if (!isValidQueryParams(params)) {
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

            const payload = (await request.json()) as QueryRequest &
                QueryTransactionRequest
            return await this.executeParsedQueryPayload(payload, isRaw)
        } catch (error: any) {
            console.error('Query Route Error:', error)
            return createResponse(
                undefined,
                error?.message || 'An unexpected error occurred.',
                500
            )
        }
    }

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
