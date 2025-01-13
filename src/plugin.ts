import type { StarbaseApp, StarbaseDBConfiguration } from './handler'
import { DataSource } from './types'

class UnimplementedError extends Error {
    constructor(public method: string) {
        super(`Method ${method} is not implemented`)
    }
}

export abstract class StarbasePlugin {
    constructor(
        public name: string,
        public opts: { requiresAuth: boolean } = { requiresAuth: true },
        public pathPrefix?: string
    ) {}

    public async register(app: StarbaseApp): Promise<void> {
        throw new UnimplementedError('register')
    }

    public async beforeQuery(opts: {
        sql: string
        params?: unknown[]
        dataSource?: DataSource
        config?: StarbaseDBConfiguration
    }): Promise<{ sql: string; params?: unknown[] }> {
        return {
            sql: opts.sql,
            params: opts.params,
        }
    }

    public async afterQuery(opts: {
        sql: string
        result: any
        isRaw: boolean
        dataSource?: DataSource
        config?: StarbaseDBConfiguration
    }): Promise<any> {
        return opts.result
    }
}

export class StarbasePluginRegistry {
    private app: StarbaseApp
    private plugins: StarbasePlugin[] = []

    constructor(opts: { app: StarbaseApp; plugins: StarbasePlugin[] }) {
        this.app = opts.app
        this.plugins = opts.plugins
    }

    async init() {
        for (const plugin of this.plugins) {
            await this.registerPlugin(plugin)
        }
    }

    private async registerPlugin(plugin: StarbasePlugin) {
        try {
            await plugin.register(this.app)
            console.log(`Plugin ${plugin.name} registered`)
        } catch (e) {
            if (e instanceof UnimplementedError) {
                return
            }

            console.error(`Error registering plugin ${plugin.name}: ${e}`)
            throw e
        }
    }

    public async beforeQuery(opts: {
        sql: string
        params?: unknown[]
        dataSource?: DataSource
        config?: StarbaseDBConfiguration
    }): Promise<{ sql: string; params?: unknown[] }> {
        let { sql, params } = opts

        for (const plugin of this.plugins) {
            const { sql: _sql, params: _params } =
                await plugin.beforeQuery(opts)
            sql = _sql
            params = _params
        }

        return {
            sql,
            params,
        }
    }

    public async afterQuery(opts: {
        sql: string
        result: any
        isRaw: boolean
        dataSource?: DataSource
        config?: StarbaseDBConfiguration
    }): Promise<any> {
        let { result } = opts

        for (const plugin of this.plugins) {
            result = await plugin.afterQuery({
                ...opts,
                result,
            })
        }

        return result
    }
}
